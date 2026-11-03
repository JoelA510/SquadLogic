import { summarizeSeats } from '@squadlogic/core/playUpSeats.js';
import { isUuid } from './teamReviewPersistence.js';
import { NOT_CHECKED_REASON } from './seatNotes.js';

/**
 * The Teams page's Play-up section (docs/changes/2026-10-27-play-up-by-request.md): every
 * play-up (requested or not), every play-down, anyone no division can hold, and every
 * waitlisted player a coach's child's buddy took off the waitlist, with the facts an admin
 * needs for the club's own rules. The app approves or refuses nothing. Derived from a team run's
 * `results` only (`playUpByDivision`, `waitlistExceptionsByDivision`, `coachNamesById`) and the
 * season's divisions, so it survives a reload, staged or synced. Pure; the rows' words are the
 * component's, the sentence's are here.
 *
 * The totals are counts of SEATS, by the division each player plays in (play-down plan, 2026-11-03,
 * PR 2): `summarizeSeats` is given one seat for each listed player and says who plays up or down. They
 * were counts of the kind each player was listed as, which is a count of where they REGISTERED: an
 * unrequested "play-up" plays in their own age division, so they are moved and not playing up.
 */

/** @typedef {import('@squadlogic/core/playUp.js').PlayUpListing & { coachName: string | null }} PlayUpRow */
/**
 * @typedef {{ playerId: string, name: string, childId: string, childName: string,
 *   coachId: string, coachName: string | null, division: string }} WaitlistRow
 * @typedef {{ division: string, divisionName: string, entries: PlayUpRow[],
 *   takenOffWaitlist: WaitlistRow[] }} PlayUpDivision
 */

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * The seats of the players a run lists, one for each (a player listed under two divisions is one
 * seat). A listed player is where the run seats them (`playedDivision`, null for a player no division
 * can hold), registered where they registered, and judged by the age the run judged them by.
 * @param {PlayUpRow[]} entries
 */
function seatsOfListing(entries) {
  const seen = new Set();
  const seats = [];
  for (const entry of entries) {
    if (entry?.playerId == null || seen.has(String(entry.playerId))) continue;
    seen.add(String(entry.playerId));
    seats.push({
      playerId: String(entry.playerId),
      naturalAge: Number.isFinite(entry.naturalAge) ? entry.naturalAge : null,
      // A listing that names neither division still has a seat: it is counted, never dropped.
      registeredDivision: entry.registeredDivision ?? entry.playedDivision ?? 'Unknown division',
      seatedDivision: entry.playedDivision ?? null,
      requested: entry.requested === true,
      waitlisted: false,
    });
  }
  return seats;
}

/**
 * @typedef {Object} PlayUpFlags
 * @property {number} playingUp - play in a division whose band is above their age
 * @property {number} playingUpRequested - of those, how many asked to
 * @property {number} playingDown - play in a division whose band is below their age
 * @property {number} moved - play in their own age division, not the one they registered in
 * @property {number} askedToPlayUp - asked to play up and registered in their own division, or with
 *   no age to judge it by: nothing to honour
 * @property {number} notChecked - the age or the division's band is unknown, so nothing was compared
 * @property {number} notPlaced - no division can hold their age
 */

/**
 * @param {any} results - a team run's `results`
 * @param {Array<Object> | null} [divisions] - the season's divisions, each with its id, name and age
 *   band, which is what a seat is judged against. `null` while they are not known: the rows are still
 *   listed, and the counts say they could not be checked.
 * @returns {{ divisions: PlayUpDivision[], totals: { takenOffWaitlist: number },
 *   flags: PlayUpFlags | null } | null} null when the run lists nobody
 */
export function summarizePlayUpReview(results, divisions = null) {
  if (!results || typeof results !== 'object') return null;
  const listings =
    results.playUpByDivision && typeof results.playUpByDivision === 'object'
      ? results.playUpByDivision
      : {};
  const waitlists =
    results.waitlistExceptionsByDivision && typeof results.waitlistExceptionsByDivision === 'object'
      ? results.waitlistExceptionsByDivision
      : {};
  const coachNames =
    results.coachNamesById && typeof results.coachNamesById === 'object'
      ? results.coachNamesById
      : {};
  const coachNameOf = (coachId) => {
    if (coachId == null) return null;
    const name = coachNames[coachId];
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  };

  /** @type {PlayUpDivision[]} */
  const summaryDivisions = [];
  const totals = { takenOffWaitlist: 0 };
  for (const division of new Set([...Object.keys(listings), ...Object.keys(waitlists)])) {
    const entries = asArray(listings[division]).map((entry) => ({
      ...entry,
      coachName: coachNameOf(entry?.coachId),
    }));
    const takenOffWaitlist = asArray(waitlists[division]).map((entry) => ({
      ...entry,
      coachName: coachNameOf(entry?.coachId),
    }));
    if (entries.length === 0 && takenOffWaitlist.length === 0) continue;
    const named = entries.find((entry) =>
      [entry.registeredDivision, entry.playedDivision].includes(division)
    );
    const nameFromEntry =
      named?.registeredDivision === division
        ? named.registeredDivisionName
        : named?.playedDivisionName;
    summaryDivisions.push({
      division,
      divisionName: nameFromEntry || division,
      entries,
      takenOffWaitlist,
    });
    totals.takenOffWaitlist += takenOffWaitlist.length;
  }
  if (summaryDivisions.length === 0) return null;

  /** @type {PlayUpFlags | null} */
  let flags = null;
  if (Array.isArray(divisions)) {
    const { league, flagged } = summarizeSeats({
      seats: seatsOfListing(summaryDivisions.flatMap((division) => division.entries)),
      divisions,
    });
    flags = {
      playingUp: league.playingUp,
      playingUpRequested: flagged.filter((seat) => seat.verdict === 'up' && seat.requested).length,
      playingDown: league.playingDown,
      moved: league.movedIn,
      askedToPlayUp: league.askedToPlayUp,
      notChecked: league.notChecked,
      notPlaced: league.notEligible,
    };
  }
  return { divisions: summaryDivisions, totals, flags };
}

/**
 * The Play-up section's one sentence, for the section and for the page's polite live region: how many
 * play up (and asked to), how many play down, how many were moved to their own age division, how many
 * asked to play up with nothing to honour, how many could not be compared, and who a coach's child's
 * buddy took off the waitlist. Play-up and play-down are always said, zero as zero. An unknown is
 * said as one: "not checked" is never folded into a zero.
 * @param {ReturnType<typeof summarizePlayUpReview>} summary
 * @returns {string} '' when nothing is listed
 */
export function playUpSentence(summary) {
  if (!summary) return '';
  const f = summary.flags;
  const parts = [];
  if (f) {
    parts.push(
      f.playingUp > 0
        ? `${f.playingUp} playing up (${f.playingUpRequested} requested)`
        : '0 playing up'
    );
    parts.push(`${f.playingDown} playing down`);
    if (f.moved > 0) parts.push(`${f.moved} moved to their own age division`);
    if (f.askedToPlayUp > 0) {
      parts.push(`${f.askedToPlayUp} asked to play up from their own division`);
    }
    if (f.notChecked > 0) parts.push(`${f.notChecked} not checked (${NOT_CHECKED_REASON})`);
    if (f.notPlaced > 0) parts.push(`${f.notPlaced} not placed (no division can hold them)`);
  } else {
    parts.push("play-up and play-down not checked yet (the season's divisions are not loaded)");
  }
  if (summary.totals.takenOffWaitlist > 0) {
    parts.push(`${summary.totals.takenOffWaitlist} taken off the waitlist`);
  }
  return parts.join(', ');
}

/**
 * One sentence for the page's polite live region, or '' when nothing is listed.
 * @param {ReturnType<typeof summarizePlayUpReview>} summary
 */
export function playUpAnnouncement(summary) {
  const sentence = playUpSentence(summary);
  return sentence ? `Play-up section: ${sentence}.` : '';
}

/**
 * The `coaches` rows the section names, whose names the run keeps in `coachNamesById`.
 * @param {ReturnType<typeof summarizePlayUpReview>} summary
 * @returns {string[]}
 */
export function coachIdsNamedByPlayUp(summary) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const division of summary?.divisions ?? []) {
    for (const entry of division.entries) if (entry.coachId) ids.add(String(entry.coachId));
    for (const entry of division.takenOffWaitlist) ids.add(String(entry.coachId));
  }
  return [...ids].filter((id) => isUuid(id));
}

/**
 * The players this run took off the waitlist who are on a roster of the run now (a manual edit
 * can move one off), by id: the ones to make active when the teams are saved.
 * @param {any} results - a team run's `results`
 * @param {any[]} [teamPlayerRows] - the snapshot's current `team_players` rows
 * @returns {string[]}
 */
export function waitlistPlayersToActivate(results, teamPlayerRows = []) {
  const seated = new Set(asArray(teamPlayerRows).map((row) => String(row?.player_id)));
  /** @type {Set<string>} */
  const ids = new Set();
  for (const entries of Object.values(results?.waitlistExceptionsByDivision ?? {})) {
    for (const entry of asArray(entries)) {
      if (seated.has(String(entry?.playerId))) ids.add(String(entry.playerId));
    }
  }
  return [...ids];
}
