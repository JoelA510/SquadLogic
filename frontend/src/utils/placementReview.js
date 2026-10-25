import { PLACEMENT, isEligibilityBlocked } from '@squadlogic/core/playUp.js';
import { TEAM_GENERATION } from '@squadlogic/core/constants.js';

/**
 * The Teams page's placement review (Phase B3, docs/changes/2026-10-22-phase-b-teaming.md):
 * who the run did not place and why, who is held on a reviewed roster though not eligible, and
 * who is placed without an eligibility check. Derived from a team run's `results` only (staged
 * or synced), so it survives a reload, and from the run's current `team_players` and `teams`, so
 * a manual roster edit shows. Pure; the words are the component's.
 */

/** Placements that are a completed check the player passed. */
const CHECKED_PLACEMENTS = new Set([PLACEMENT.IN_BAND, PLACEMENT.PLAY_UP_SANCTIONED]);

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

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
  const noteName = (id, name) => {
    if (id != null && name && !nameById.has(String(id))) nameById.set(String(id), String(name));
  };

  const teamsByDivision = results?.teamsByDivision;
  const hasRosters = teamsByDivision != null && typeof teamsByDivision === 'object';
  for (const [division, teams] of Object.entries(hasRosters ? teamsByDivision : {})) {
    for (const team of Array.isArray(teams) ? teams : []) {
      const teamId = String(team?.id);
      if (team?.name) teamNameById.set(teamId, String(team.name));
      divisionByTeamId.set(teamId, division);
      for (const player of Array.isArray(team?.players) ? team.players : []) {
        const id = String(player?.id);
        noteName(id, displayName(player));
        if (!generatedById.has(id)) generatedById.set(id, { player, division, teamId });
      }
    }
  }
  // A not-placed player carries their placement too, for when an admin seats them by hand.
  /** @type {Map<string, any>} */
  const overflowPlayerById = new Map();
  for (const entries of Object.values(results?.overflowByDivision || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const player of Array.isArray(entry?.players) ? entry.players : []) {
        const id = String(player?.id);
        noteName(id, displayName(player));
        if (!overflowPlayerById.has(id)) overflowPlayerById.set(id, player);
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
    if (row?.role && row.role !== 'player') continue;
    const id = String(row?.player_id);
    noteName(id, row?.player_name);
    if (!currentTeamOf.has(id)) currentTeamOf.set(id, String(row?.team_id));
  }
  if (rows.length === 0) {
    for (const [id, entry] of generatedById) currentTeamOf.set(id, entry.teamId);
  }

  return {
    hasRosters,
    nameById,
    teamNameById,
    divisionByTeamId,
    generatedById,
    overflowPlayerById,
    currentTeamOf,
  };
}

/**
 * @typedef {{ playerId: string, name: string, reason: string, placement: string | null,
 *   reviewReason: string | null, naturalAge: number | null, currentTeamName: string | null }} NotPlacedEntry
 * @typedef {{ playerId: string, name: string, teamName: string | null, placement: string | null,
 *   reviewReason: string | null }} NeedsReviewEntry
 * @typedef {{ playerId: string, name: string, teamName: string | null,
 *   placement: string | null }} UncheckedEntry
 * @typedef {{ division: string, notPlaced: NotPlacedEntry[], needsReview: NeedsReviewEntry[],
 *   unchecked: UncheckedEntry[], placedCount: number, rostersKnown: boolean }} DivisionReview
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
 *   (`unknown`, an unrecognised value, or none recorded). Only said when the run carries its
 *   generated rosters (`teamsByDivision`); a run without them cannot tell.
 *
 * @param {any} results
 * @returns {{ divisions: DivisionReview[], totals: { notPlaced: number, notEligible: number,
 *   needsReview: number, unchecked: number } } | null}
 */
export function summarizePlacementReview(results) {
  if (!results || typeof results !== 'object') return null;
  const run = indexRun(results);
  const overflowByDivision = results.overflowByDivision || {};
  const changesByDivision = results.changeDiagnosticsByDivision || {};
  const nameOf = (id) => run.nameById.get(String(id)) ?? String(id);
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
        placedCount: 0,
        rostersKnown: run.hasRosters,
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
        const currentTeamId = run.currentTeamOf.get(id);
        review.notPlaced.push({
          playerId: id,
          name: displayName(player) ?? nameOf(id),
          reason,
          placement: metadata.placement ?? player?.placement ?? null,
          reviewReason: metadata.reviewReason ?? player?.reviewReason ?? null,
          naturalAge: finiteOrNull(metadata.naturalAge) ?? finiteOrNull(player?.naturalAge),
          currentTeamName: currentTeamId === undefined ? null : teamNameOf(currentTeamId),
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
      run.divisionByTeamId.get(teamId) ?? generated?.division ?? TEAM_GENERATION.REASON_Unknown;
    const review = divisionOf(division);
    review.placedCount += 1;
    if (!run.hasRosters) continue;
    const player = generated?.player ?? run.overflowPlayerById.get(id);
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

  const divisions = [...byDivision.values()];
  if (divisions.length === 0) return null;
  const totals = { notPlaced: 0, notEligible: 0, needsReview: 0, unchecked: 0 };
  for (const review of divisions) {
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
  const { notPlaced, notEligible, needsReview, unchecked } = summary.totals;
  const parts = [];
  if (notPlaced > 0) {
    const forRoom = notPlaced - notEligible;
    const why = [
      notEligible > 0 ? `${notEligible} not eligible for the division` : null,
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
  return parts.length > 0 ? `Players to review: ${parts.join('; ')}.` : '';
}

/**
 * Each not-placed player of a run, by id, with the reason: for the Buddy requests list, which
 * says why a pair is not together.
 * @param {any} results
 * @returns {Map<string, { reason: string, name: string }>}
 */
export function notPlacedById(results) {
  /** @type {Map<string, { reason: string, name: string }>} */
  const byId = new Map();
  for (const entries of Object.values(results?.overflowByDivision || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const reason = entry?.reason ? String(entry.reason) : TEAM_GENERATION.REASON_Unknown;
      for (const player of Array.isArray(entry?.players) ? entry.players : []) {
        const id = String(player?.id);
        if (!byId.has(id)) byId.set(id, { reason, name: displayName(player) ?? id });
      }
    }
  }
  return byId;
}
