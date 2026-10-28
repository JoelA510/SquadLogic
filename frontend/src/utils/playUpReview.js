import { isUuid } from './teamReviewPersistence.js';

/**
 * The Teams page's Play-up section (docs/changes/2026-10-27-play-up-by-request.md): every
 * play-up (requested or not), every play-down, anyone no division can hold, and every
 * waitlisted player a coach's child's buddy took off the waitlist, with the facts an admin
 * needs for the club's own rules. The app approves or refuses nothing. Derived from a team run's
 * `results` only (`playUpByDivision`, `waitlistExceptionsByDivision`, `coachNamesById`), so it
 * survives a reload, staged or synced. Pure; the words are the component's.
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
 * @param {any} results - a team run's `results`
 * @returns {{ divisions: PlayUpDivision[], totals: { playUps: number, requested: number,
 *   unrequested: number, playDowns: number, requestedInOwnDivision: number, notPlaced: number,
 *   takenOffWaitlist: number } } | null} null when the run lists nobody
 */
export function summarizePlayUpReview(results) {
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
  const divisions = [];
  const totals = {
    playUps: 0,
    requested: 0,
    unrequested: 0,
    playDowns: 0,
    requestedInOwnDivision: 0,
    notPlaced: 0,
    takenOffWaitlist: 0,
  };
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
    divisions.push({
      division,
      divisionName: nameFromEntry || division,
      entries,
      takenOffWaitlist,
    });
    for (const entry of entries) {
      if (entry.kind === 'play-up') {
        totals.playUps += 1;
        totals[entry.requested ? 'requested' : 'unrequested'] += 1;
      } else if (entry.kind === 'play-down') totals.playDowns += 1;
      else if (entry.kind === 'no-division') totals.notPlaced += 1;
      else totals.requestedInOwnDivision += 1;
    }
    totals.takenOffWaitlist += takenOffWaitlist.length;
  }
  return divisions.length > 0 ? { divisions, totals } : null;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One sentence for the page's polite live region, or '' when nothing is listed.
 * @param {ReturnType<typeof summarizePlayUpReview>} summary
 */
export function playUpAnnouncement(summary) {
  if (!summary) return '';
  const t = summary.totals;
  const parts = [];
  if (t.playUps > 0) {
    parts.push(`${count(t.playUps, 'play-up', 'play-ups')} (${t.requested} requested)`);
  }
  if (t.playDowns > 0) parts.push(count(t.playDowns, 'play-down', 'play-downs'));
  if (t.requestedInOwnDivision > 0) {
    parts.push(
      `${count(t.requestedInOwnDivision, 'request', 'requests')} to play up from the player's own division`
    );
  }
  if (t.notPlaced > 0) parts.push(`${t.notPlaced} no division can hold`);
  if (t.takenOffWaitlist > 0) parts.push(`${t.takenOffWaitlist} taken off the waitlist`);
  return parts.length > 0 ? `Play-up section: ${parts.join('; ')}.` : '';
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
