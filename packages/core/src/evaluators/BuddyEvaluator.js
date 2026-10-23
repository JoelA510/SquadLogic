import { BaseEvaluator } from './BaseEvaluator.js';

/**
 * BuddyEvaluator (Phase 1.2)
 * Ensures mutual buddies are assigned together.
 *
 * Note: While assignment units already handle mutual buddies, this evaluator
 * protects against accidental separation during future "Move Player" actions
 * or manual overrides.
 */
export class BuddyEvaluator extends BaseEvaluator {
  constructor() {
    super('Buddy Compatibility', 'buddy_evaluator');
  }

  /**
   * Evaluates if a buddy is already present or if assigning here would separate buddies.
   *
   * @param {Object} context
   * @returns {number} Score from 0 to 100.
   */
  evaluate(context) {
    const { player, team, allTeams } = context;
    const buddyId = player.buddyId;
    if (buddyId) {
      // 1. Is the buddy already on this team?
      const buddyOnThisTeam = team.players.find((p) => p.id === buddyId);
      if (buddyOnThisTeam) return 100;

      // 2. Is the buddy already on a DIFFERENT team?
      const buddyOnOtherTeam = allTeams.find(
        (t) => t.id !== team.id && t.players.find((p) => p.id === buddyId)
      );
      if (buddyOnOtherTeam) {
        // If buddy is elsewhere, this assignment is a direct conflict
        return 0;
      }
      // 3. Buddy is not yet assigned: judged below, as anyone named by a placed player is.
      // (Mutual buddy pairs are placed as one unit by buildTeamsForDivision.)
    }

    // 4. A one-way request (Phase B1, `one_way_best_effort`) sets `buddyId` on the requester
    // only. When the requester was placed first, the player they named is steered to them
    // here, so the request is honoured whichever of the two is placed first. Best effort
    // only: it scores, it never forms a unit.
    if (team.players.some((p) => p.buddyId === player.id)) return 100;
    const requesterElsewhere = allTeams.some(
      (t) => t.id !== team.id && t.players.some((p) => p.buddyId === player.id)
    );
    return requesterElsewhere ? 0 : 100;
  }

  getDiagnostics(context) {
    const score = this.evaluate(context);
    const { player, team, allTeams } = context;
    const buddyId = player.buddyId;

    if (!buddyId) {
      return {
        id: this.id,
        name: this.name,
        score: 100,
        reasons: ['No buddy request.'],
        warnings: [],
      };
    }

    const buddy = allTeams.flatMap((t) => t.players).find((p) => p.id === buddyId);
    const buddyOnThisTeam = team.players.find((p) => p.id === buddyId);

    return {
      id: this.id,
      name: this.name,
      score,
      reasons: buddyOnThisTeam
        ? [`Mutual buddy "${buddy?.name || buddyId}" is on this team.`]
        : [`Buddy requested: ${buddyId}`],
      warnings:
        score === 0 ? [`Buddy "${buddy?.name || buddyId}" is assigned to a different team!`] : [],
    };
  }
}
