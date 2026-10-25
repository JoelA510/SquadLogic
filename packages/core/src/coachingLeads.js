/**
 * Coaching leads (Phase B6, `docs/changes/2026-10-22-phase-b-teaming.md`): the one rule the
 * team generator (`teamGeneration.js`) and TeamBuilder's auto-balance (`balanceSignals.js`)
 * both deal by.
 *
 * A coaching lead is a player whose registration says a parent volunteers to coach
 * (`players.willing_to_coach`). A lead is not a coach: only a coach linked to a child through
 * `coach_team_requests` anchors a team. The owner's order a division's teams are filled in:
 *
 *   1. coaches' children, with their buddies as the league's buddy rule allows (the
 *      generator; a Team Builder board has no coach anchors);
 *   2. leads, spread so no two teams differ by more than one, except where a buddy unit holds
 *      more than one lead: units holding a lead are dealt first, the most leads first, each to a
 *      team with the fewest leads;
 *   3. experience and skill balance, with compensation: every other unit goes to the team
 *      with the lowest `signal total + c × leads`, where `c` is the division's mean player
 *      signal times `LEAD_COMPENSATION_FACTOR` (one lead counts as one average player; the plan's
 *      "mean unit signal" read per player, so a buddy pair does not count as one player).
 *
 * The signal is the league's own (`balanceSignalKind` and `playerSignal`): years played, or the
 * skill rating when the league rates players. With neither, or when no player of the division
 * carries it (`carriesSignal`), there is nothing to compensate with: `c` is 0, and the
 * generator's evaluators balance the rest as they do without leads. With the league's
 * `teaming_spread_coaching_leads` setting off, steps 2 and 3's compensation are skipped and
 * leads are ordinary players.
 *
 * Pure module: no React, no I/O.
 */

/**
 * The league setting, a boolean organization feature flag (frontend
 * `FEATURE_FLAGS.TEAMING_SPREAD_COACHING_LEADS`; `tests/coachingLeads.test.js` holds the two
 * equal). On by default: an absent key spreads.
 */
export const SPREAD_COACHING_LEADS_FLAG = 'teaming_spread_coaching_leads';

/**
 * How much one lead weighs in a team's load, in average players: `c = factor × mean player
 * signal`. Tuned against `fixtures/demo-2026/` (the "As built (B6)" section of the plan).
 */
export const LEAD_COMPENSATION_FACTOR = 1;

/**
 * The answers to the import's coaching question that mean a parent volunteers, as
 * `finalize_import_job` reads them into `players.willing_to_coach` (migration 20261022010000)
 * and the mock finalizer mirrors. Compared lower-cased and trimmed.
 */
export const COACHING_LEAD_ANSWERS = Object.freeze([
  'true',
  't',
  'yes',
  'y',
  '1',
  'maybe',
  'coach',
  'head coach',
  'assistant coach',
  'volunteer',
  'willing',
]);

/**
 * True when an import answer (or a stored boolean) says a parent volunteers to coach.
 * @param {unknown} value
 */
export function isCoachingLeadAnswer(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return COACHING_LEAD_ANSWERS.includes(String(value).trim().toLowerCase());
}

/**
 * Whether a player is a coaching lead: a generator player's `isCoachingLead`, or a stored
 * player's `willing_to_coach` (the Team Builder board's rows).
 * @param {any} player
 */
export function isCoachingLead(player) {
  return player?.isCoachingLead === true || player?.willing_to_coach === true;
}

/**
 * The number of leads among `players`.
 * @param {any[]} players
 */
export function countLeads(players = []) {
  return players.reduce((total, player) => total + (isCoachingLead(player) ? 1 : 0), 0);
}

/**
 * Whether the league spreads leads (the setting; absent means on).
 * @param {Record<string, unknown> | null | undefined} featureFlags
 */
export function spreadsCoachingLeads(featureFlags) {
  return featureFlags?.[SPREAD_COACHING_LEADS_FLAG] !== false;
}

/**
 * `c`: what one lead adds to a team's load. The mean of the division's player signals times
 * the factor; 0 with no signals, or when the signal is roster size only (`'size'`), which has
 * no experienced or skilled players to give.
 * @param {number[]} signals - one per player of the division
 * @param {{ signalKind?: string, factor?: number }} [options]
 */
export function leadCompensation(signals, { signalKind, factor = LEAD_COMPENSATION_FACTOR } = {}) {
  if (signalKind === 'size' || signals.length === 0) return 0;
  const mean = signals.reduce((total, value) => total + value, 0) / signals.length;
  return factor * mean;
}

/**
 * A team's load: its signal total, plus `c` for each lead it holds.
 * @param {number} signalTotal
 * @param {number} leads
 * @param {number} c
 */
export function compensatedLoad(signalTotal, leads, c) {
  return signalTotal + c * leads;
}

/**
 * The candidates holding the fewest leads (step 2). Returns `candidates` itself when it is
 * empty.
 * @template T
 * @param {T[]} candidates
 * @param {(candidate: T) => number} leadsOf
 * @returns {T[]}
 */
export function withFewestLeads(candidates, leadsOf) {
  if (candidates.length === 0) return candidates;
  const fewest = Math.min(...candidates.map(leadsOf));
  return candidates.filter((candidate) => leadsOf(candidate) === fewest);
}

/**
 * The order units are dealt in once coaches' children are placed: units holding a lead first,
 * the most leads first (so a buddy unit with two is placed while every team still has room to
 * stay within one of the others), then by `weightOf` descending. Stable: units that compare
 * equal keep their order.
 * @template T
 * @param {T[]} units
 * @param {{ leadsOf: (unit: T) => number, weightOf: (unit: T) => number }} accessors
 * @returns {T[]}
 */
export function orderForLeadDeal(units, { leadsOf, weightOf }) {
  return [...units].sort((a, b) => leadsOf(b) - leadsOf(a) || weightOf(b) - weightOf(a));
}
