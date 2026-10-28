import { PLACEMENT, isEligibilityBlocked } from '@squadlogic/core/playUp.js';
import { TEAM_GENERATION } from '@squadlogic/core/constants.js';
import { getCanonicalBuddyId } from '@squadlogic/core/buddyLinking.js';
import { isRosterPlayerRow, isUuid } from './teamReviewPersistence.js';

/**
 * The Teams page's placement review (Phase B3, docs/changes/2026-10-22-phase-b-teaming.md):
 * who the run did not place and why, who is held on a reviewed roster though not eligible, and
 * who is placed without an eligibility check. Derived from a team run's `results` only (staged
 * or synced), so it survives a reload, and from the run's current `team_players` and `teams`, so
 * a manual roster edit shows. Pure; the words are the component's.
 */

/** Placements that are a completed check the player passed. */
const CHECKED_PLACEMENTS = new Set([PLACEMENT.IN_BAND, PLACEMENT.PLAY_UP_SANCTIONED]);

/** The reasons a player is held out of every team, so a coach whose only child it is has none. */
const HELD_OUT_REASONS = new Set([
  TEAM_GENERATION.REASON_EligibilityBlocked,
  TEAM_GENERATION.REASON_Waitlisted,
]);

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/** The group a placed player is listed under when the run does not say which team's division. */
const DIVISION_NOT_RECORDED = 'Division not recorded';

function displayName(player) {
  if (!player) return null;
  const name =
    (typeof player.name === 'string' && player.name.trim()) ||
    `${player.firstName ?? player.first_name ?? ''} ${player.lastName ?? player.last_name ?? ''}`.trim();
  return name || null;
}

/**
 * @param {any} results - a team run's `results` (`buildTeamReviewSnapshot`'s shape)
 */
function indexRun(results) {
  /** @type {Map<string, string>} */
  const nameById = new Map();
  /** @type {Map<string, string>} */
  const teamNameById = new Map();
  /** @type {Map<string, string>} */
  const divisionByTeamId = new Map();
  /** @type {Map<string, { player: any, division: string, teamId: string }>} */
  const generatedById = new Map();
  // Each division's generated teams, and the coaches who anchor one. A run without a division's
  // `teamsByDivision` cannot say whether a coach has a team there.
  /** @type {Map<string, Set<string>>} */
  const coachesWithTeamByDivision = new Map();
  const noteName = (id, name) => {
    if (id != null && name && !nameById.has(String(id))) nameById.set(String(id), String(name));
  };

  // The divisions whose generated rosters hold player records (with each player's placement).
  // A run without them (a seeded run, or rosters rebuilt from team rows with no players) cannot
  // tell who was checked.
  /** @type {Set<string>} */
  const divisionsWithRosters = new Set();
  const teamsByDivision = results?.teamsByDivision;
  for (const [division, teams] of Object.entries(
    teamsByDivision && typeof teamsByDivision === 'object' ? teamsByDivision : {}
  )) {
    if (Array.isArray(teams)) coachesWithTeamByDivision.set(division, new Set());
    for (const team of Array.isArray(teams) ? teams : []) {
      const teamId = String(team?.id);
      if (team?.coachId) coachesWithTeamByDivision.get(division)?.add(String(team.coachId));
      if (team?.name) teamNameById.set(teamId, String(team.name));
      divisionByTeamId.set(teamId, division);
      for (const player of Array.isArray(team?.players) ? team.players : []) {
        const id = String(player?.id);
        noteName(id, displayName(player));
        divisionsWithRosters.add(division);
        if (!generatedById.has(id)) generatedById.set(id, { player, division, teamId });
      }
    }
  }
  for (const team of Array.isArray(results?.teams) ? results.teams : []) {
    const teamId = String(team?.id);
    if (team?.name && !teamNameById.has(teamId)) teamNameById.set(teamId, String(team.name));
    const division = team?.division ?? team?.divisionName;
    if (division != null && !divisionByTeamId.has(teamId)) {
      divisionByTeamId.set(teamId, String(division));
    }
  }

  // Where each player is now: the run's rows when it has them (a manual edit rewrites them),
  // otherwise the generated rosters.
  /** @type {Map<string, string>} */
  const currentTeamOf = new Map();
  const rows = Array.isArray(results?.team_players) ? results.team_players : [];
  for (const row of rows) {
    if (!isRosterPlayerRow(row)) continue;
    const id = String(row?.player_id);
    noteName(id, row?.player_name);
    if (!currentTeamOf.has(id)) currentTeamOf.set(id, String(row?.team_id));
  }
  if (rows.length === 0) {
    for (const [id, entry] of generatedById) currentTeamOf.set(id, entry.teamId);
  }

  return {
    nameById,
    teamNameById,
    divisionByTeamId,
    generatedById,
    divisionsWithRosters,
    currentTeamOf,
    coachesWithTeamByDivision,
  };
}

/**
 * @typedef {{ playerId: string, name: string, reason: string, placement: string | null,
 *   reviewReason: string | null, naturalAge: number | null, coachId: string | null,
 *   coachWithoutTeam: { coachId: string, name: string | null } | null }} NotPlacedEntry
 * @typedef {{ playerId: string, name: string, teamName: string | null, placement: string | null,
 *   reviewReason: string | null }} NeedsReviewEntry
 * @typedef {{ playerId: string, name: string, teamName: string | null,
 *   placement: string | null }} UncheckedEntry
 * @typedef {{ coachId: string, name: string | null, together: boolean, children: Array<{
 *   playerId: string, name: string, teamName: string | null, notPlacedReason: string | null }> }} SiblingGroup
 * @typedef {{ division: string, notPlaced: NotPlacedEntry[], needsReview: NeedsReviewEntry[],
 *   unchecked: UncheckedEntry[], siblings: SiblingGroup[], placedCount: number,
 *   rostersKnown: boolean }} DivisionReview
 */

/**
 * The placement review of a run, per division, or null when the run carries nothing to say it
 * from (no rosters and no overflow).
 *
 * - **Not placed:** every player in `overflowByDivision`, whatever the reason: eligibility
 *   (`eligibility-blocked`) and room (capacity, a buddy's or coach's team) alike, each with its
 *   own reason, and a reason this page has no words for kept as its code.
 * - **Needs review:** `changeDiagnosticsByDivision[div].eligibilityHolds`, and any blocked player
 *   found on a current roster that the holds do not name (enumerated from the rosters, not from
 *   the holds alone).
 * - **Eligibility not checked:** each placed player whose placement is not a passed check
 *   (`unknown`, an unrecognised value, or none recorded). Only said for a division whose
 *   generated rosters (`teamsByDivision`) hold player records; a run without them cannot tell.
 * - **Coach with no team to anchor:** a not-placed player the generator held out (not eligible,
 *   or waitlisted) whose coach (`metadata.coachId`, from a `coach_team_requests` link) anchors no
 *   team of the division: the coach's only child there. Said on the player's entry, with the
 *   coach's name from `results.coachNamesById`. Only for a division whose `teamsByDivision` is in
 *   the run, since a run without it cannot say who has a team.
 * - **Coach with more than one child:** `siblings`, per division: each coach with two or more
 *   children (placed or not) in it, the team each is on now, and whether they are together. Not
 *   said for two children who name each other as buddies, who are one unit. The admin decides
 *   whether to keep siblings together; nothing pairs them.
 *
 * @param {any} results
 * @returns {{ divisions: DivisionReview[], totals: { notPlaced: number, notEligible: number,
 *   needsReview: number, unchecked: number, waitlisted: number, coachesWithoutTeam: number,
 *   siblingGroups: number,
 *   siblingGroupsApart: number } } | null}
 */
export function summarizePlacementReview(results) {
  if (!results || typeof results !== 'object') return null;
  const run = indexRun(results);
  const overflowByDivision = results.overflowByDivision || {};
  const changesByDivision = results.changeDiagnosticsByDivision || {};
  const nameOf = (id) => run.nameById.get(String(id)) ?? String(id);
  const coachNames =
    results.coachNamesById && typeof results.coachNamesById === 'object'
      ? results.coachNamesById
      : {};
  // A coach linked through `coach_team_requests` is a `coaches` row (a UUID) with a name on file.
  // An id that is not a UUID (a caller's own label) labels itself.
  const coachNameOf = (coachId) => {
    if (typeof coachNames[coachId] === 'string' && coachNames[coachId].trim()) {
      return coachNames[coachId].trim();
    }
    return isUuid(coachId) ? null : coachId;
  };
  const teamNameOf = (teamId) =>
    teamId == null ? null : (run.teamNameById.get(String(teamId)) ?? String(teamId));

  /** @type {Map<string, DivisionReview>} */
  const byDivision = new Map();
  const divisionOf = (key) => {
    const division = String(key);
    if (!byDivision.has(division)) {
      byDivision.set(division, {
        division,
        notPlaced: [],
        needsReview: [],
        unchecked: [],
        siblings: [],
        placedCount: 0,
        rostersKnown: run.divisionsWithRosters.has(division),
      });
    }
    return /** @type {DivisionReview} */ (byDivision.get(division));
  };

  for (const [division, entries] of Object.entries(overflowByDivision)) {
    if (!Array.isArray(entries)) continue;
    const review = divisionOf(division);
    for (const entry of entries) {
      const reason = entry?.reason ? String(entry.reason) : TEAM_GENERATION.REASON_Unknown;
      const metadata = entry?.metadata || {};
      for (const player of Array.isArray(entry?.players) ? entry.players : []) {
        const id = String(player?.id);
        const coachId = metadata.coachId ?? player?.coachId ?? null;
        const coachesWithTeam = run.coachesWithTeamByDivision.get(String(division));
        review.notPlaced.push({
          playerId: id,
          name: displayName(player) ?? nameOf(id),
          reason,
          placement: metadata.placement ?? player?.placement ?? null,
          reviewReason: metadata.reviewReason ?? player?.reviewReason ?? null,
          naturalAge: finiteOrNull(metadata.naturalAge) ?? finiteOrNull(player?.naturalAge),
          coachId: coachId === null ? null : String(coachId),
          coachWithoutTeam:
            coachId !== null &&
            HELD_OUT_REASONS.has(reason) &&
            coachesWithTeam !== undefined &&
            !coachesWithTeam.has(String(coachId))
              ? { coachId: String(coachId), name: coachNameOf(String(coachId)) }
              : null,
        });
      }
    }
  }

  /** @type {Set<string>} */
  const listedForReview = new Set();
  for (const [division, changes] of Object.entries(changesByDivision)) {
    const holds = changes?.eligibilityHolds;
    if (!Array.isArray(holds)) continue;
    const review = divisionOf(division);
    for (const hold of holds) {
      const id = String(hold?.playerId);
      if (listedForReview.has(id)) continue;
      listedForReview.add(id);
      // The team they are on now, which a manual move may have changed; the hold's own team
      // when the run has no rows for them.
      const teamId = run.currentTeamOf.get(id) ?? hold?.teamId ?? null;
      review.needsReview.push({
        playerId: id,
        name: nameOf(id),
        teamName: teamNameOf(teamId),
        placement: hold?.placement ?? null,
        reviewReason: hold?.reviewReason ?? null,
      });
    }
  }

  for (const [id, teamId] of run.currentTeamOf) {
    const generated = run.generatedById.get(id);
    const division =
      run.divisionByTeamId.get(teamId) ?? generated?.division ?? DIVISION_NOT_RECORDED;
    const review = divisionOf(division);
    review.placedCount += 1;
    if (!review.rostersKnown) continue;
    const player = generated?.player;
    if (player && isEligibilityBlocked(player)) {
      if (listedForReview.has(id)) continue;
      listedForReview.add(id);
      review.needsReview.push({
        playerId: id,
        name: nameOf(id),
        teamName: teamNameOf(teamId),
        placement: player.placement,
        reviewReason: player.reviewReason ?? null,
      });
      continue;
    }
    if (player && CHECKED_PLACEMENTS.has(player.placement)) continue;
    review.unchecked.push({
      playerId: id,
      name: nameOf(id),
      teamName: teamNameOf(teamId),
      placement: typeof player?.placement === 'string' ? player.placement : null,
    });
  }

  // Coaches with more than one child in a division: placed children from the generated rosters
  // (the team each is on now), the rest from the overflow. Enumerated from both, never from the
  // coach links alone.
  /** @type {Map<string, Map<string, Map<string, { player: any, teamId: string | null, notPlacedReason: string | null }>>>} */
  const childrenByDivision = new Map();
  const noteChild = (division, player, teamId, notPlacedReason) => {
    if (player?.coachId == null || player.coachId === '') return;
    const byCoach = childrenByDivision.get(division) ?? new Map();
    childrenByDivision.set(division, byCoach);
    const children = byCoach.get(String(player.coachId)) ?? new Map();
    byCoach.set(String(player.coachId), children);
    if (!children.has(String(player.id))) {
      children.set(String(player.id), { player, teamId, notPlacedReason });
    }
  };
  for (const [id, generated] of run.generatedById) {
    noteChild(generated.division, generated.player, run.currentTeamOf.get(id) ?? null, null);
  }
  for (const [division, entries] of Object.entries(overflowByDivision)) {
    if (!Array.isArray(entries) || !run.coachesWithTeamByDivision.has(String(division))) continue;
    for (const entry of entries) {
      const reason = entry?.reason ? String(entry.reason) : TEAM_GENERATION.REASON_Unknown;
      for (const player of Array.isArray(entry?.players) ? entry.players : []) {
        noteChild(String(division), player, null, reason);
      }
    }
  }
  for (const [division, byCoach] of childrenByDivision) {
    for (const [coachId, children] of byCoach) {
      if (children.size < 2) continue;
      const [first, second] = [...children.values()].map((child) => child.player);
      // Two children who name each other are one unit: placed together, nothing to decide.
      if (
        children.size === 2 &&
        getCanonicalBuddyId(first) === String(second.id) &&
        getCanonicalBuddyId(second) === String(first.id)
      ) {
        continue;
      }
      const placed = [...children.values()].filter((child) => child.notPlacedReason === null);
      const teamIds = new Set(placed.map((child) => child.teamId));
      divisionOf(division).siblings.push({
        coachId,
        name: coachNameOf(coachId),
        together: placed.length === children.size && teamIds.size === 1 && !teamIds.has(null),
        children: [...children.values()].map((child) => ({
          playerId: String(child.player.id),
          name: displayName(child.player) ?? nameOf(child.player.id),
          teamName: teamNameOf(child.teamId),
          notPlacedReason: child.notPlacedReason,
        })),
      });
    }
  }

  const divisions = [...byDivision.values()];
  if (divisions.length === 0) return null;
  const totals = {
    notPlaced: 0,
    notEligible: 0,
    needsReview: 0,
    unchecked: 0,
    waitlisted: 0,
    coachesWithoutTeam: 0,
    siblingGroups: 0,
    siblingGroupsApart: 0,
  };
  for (const review of divisions) {
    totals.coachesWithoutTeam += new Set(
      review.notPlaced.filter((entry) => entry.coachWithoutTeam).map((entry) => entry.coachId)
    ).size;
    totals.siblingGroups += review.siblings.length;
    totals.siblingGroupsApart += review.siblings.filter((group) => !group.together).length;
    totals.waitlisted += review.notPlaced.filter(
      (entry) => entry.reason === TEAM_GENERATION.REASON_Waitlisted
    ).length;
    totals.notPlaced += review.notPlaced.length;
    totals.notEligible += review.notPlaced.filter(
      (entry) => entry.reason === TEAM_GENERATION.REASON_EligibilityBlocked
    ).length;
    totals.needsReview += review.needsReview.length;
    totals.unchecked += review.unchecked.length;
  }
  return { divisions, totals };
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One sentence for the page's polite live region, or '' when there is nothing to review.
 * @param {ReturnType<typeof summarizePlacementReview>} summary
 */
export function placementReviewAnnouncement(summary) {
  if (!summary) return '';
  const {
    notPlaced,
    notEligible,
    waitlisted,
    needsReview,
    unchecked,
    coachesWithoutTeam,
    siblingGroups,
    siblingGroupsApart,
  } = summary.totals;
  const parts = [];
  if (notPlaced > 0) {
    const forRoom = notPlaced - notEligible - waitlisted;
    const why = [
      notEligible > 0 ? `${notEligible} not eligible for the division` : null,
      waitlisted > 0 ? `${waitlisted} on the waitlist` : null,
      forRoom > 0 ? `${forRoom} for another reason` : null,
    ].filter(Boolean);
    parts.push(`${count(notPlaced, 'player', 'players')} not placed (${why.join(', ')})`);
  }
  if (needsReview > 0) {
    parts.push(`${count(needsReview, 'player needs', 'players need')} review`);
  }
  if (unchecked > 0) {
    parts.push(`${count(unchecked, 'placed player', 'placed players')}: eligibility not checked`);
  }
  if (coachesWithoutTeam > 0) {
    parts.push(`${count(coachesWithoutTeam, 'coach has', 'coaches have')} no team to anchor`);
  }
  if (siblingGroups > 0) {
    const apart = siblingGroupsApart > 0 ? ` (${siblingGroupsApart} not together)` : '';
    parts.push(
      `${count(siblingGroups, 'coach has', 'coaches have')} more than one child in a division${apart}`
    );
  }
  return parts.length > 0 ? `Players to review: ${parts.join('; ')}.` : '';
}

/**
 * Each not-placed player of a run, by id, with the reason: for the Buddy requests list, which
 * says why a pair is not together. A player the run's current rows seat is not in it.
 * @param {any} results
 * @returns {Map<string, { reason: string, name: string }>}
 */
export function notPlacedById(results) {
  /** @type {Map<string, { reason: string, name: string }>} */
  const byId = new Map();
  const rows = Array.isArray(results?.team_players) ? results.team_players : [];
  const seated = new Set(rows.filter(isRosterPlayerRow).map((row) => String(row?.player_id)));
  for (const entries of Object.values(results?.overflowByDivision || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const reason = entry?.reason ? String(entry.reason) : TEAM_GENERATION.REASON_Unknown;
      for (const player of Array.isArray(entry?.players) ? entry.players : []) {
        const id = String(player?.id);
        if (seated.has(id)) continue;
        if (!byId.has(id)) byId.set(id, { reason, name: displayName(player) ?? id });
      }
    }
  }
  return byId;
}

/**
 * The `coaches` rows the review names (a coach with no team to anchor, a coach with more than
 * one child), whose names the run keeps in `coachNamesById`. The team run holds ids only.
 * @param {ReturnType<typeof summarizePlacementReview>} summary
 * @returns {string[]}
 */
export function coachIdsNamedByReview(summary) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const review of summary?.divisions ?? []) {
    for (const entry of review.notPlaced) {
      if (entry.coachWithoutTeam) ids.add(entry.coachWithoutTeam.coachId);
    }
    for (const group of review.siblings) ids.add(group.coachId);
  }
  // Only `coaches` rows have a name to read; a coach the import row names is its own label.
  return [...ids].filter((id) => isUuid(id));
}
