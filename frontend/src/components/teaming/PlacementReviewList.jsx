import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { TEAM_GENERATION } from '@squadlogic/core/constants.js';
import { summarizePlacementReview } from '../../utils/placementReview.js';

/** Why the generator left a player off every team, in words (`overflowByDivision[].reason`). */
const NOT_PLACED_REASONS = {
  'insufficient-capacity': 'No room: the teams were full.',
  'coach-capacity': "No room on their coach's team.",
  'buddy-target-capacity': "No room on their buddy's team.",
  'buddy-target-locked': "Their buddy's team is locked.",
};

/** Why a placement fails the division's age band, in words (`applyPlayUpEligibility`). */
const BLOCKED_PLACEMENTS = {
  play_down_blocked: 'Older than the division allows, and playing down is not permitted.',
  play_up_blocked:
    "Younger than the division allows, with no coaching parent or coach's child as a buddy to sanction playing up.",
};

function eligibilityText(placement, reviewReason) {
  const why =
    BLOCKED_PLACEMENTS[placement] ||
    (reviewReason
      ? `${reviewReason.charAt(0).toUpperCase()}${reviewReason.slice(1)}.`
      : `Placement “${placement ?? 'none'}”.`);
  return `Not eligible for this division. ${why}`;
}

function notPlacedText(entry) {
  if (entry.reason === TEAM_GENERATION.REASON_EligibilityBlocked) {
    return eligibilityText(entry.placement, entry.reviewReason);
  }
  // A reason this list has no words for is still shown, as the generator recorded it.
  return NOT_PLACED_REASONS[entry.reason] || `Not placed (reason recorded: “${entry.reason}”).`;
}

const ageText = (naturalAge) =>
  naturalAge === null ? 'Natural age unknown.' : `Natural age ${naturalAge}.`;

const anchorId = (division, list) =>
  `placement-review-${division}-${list}`.replace(/[^A-Za-z0-9_-]/g, '-');

/**
 * The placement review of a team run (Phase B3): "Not placed" (each player the run left off
 * every team, the reason in words and the natural age), "Needs review" (a player kept on a
 * reviewed roster though not eligible for the division: who, on which team, why) and
 * "Eligibility not checked" (placed players with no age to check, flagged beside their name;
 * nothing holds them off a roster). Read from the run's `results`, so a staged or synced run
 * shows it after a reload, and a manual roster edit moves the team shown. Following the TIME
 * TBD rule, nobody the run did not place is left out, whatever the reason. Announced by the
 * page's own live region, once per generation, not here.
 */
export default function PlacementReviewList({ results }) {
  const summary = useMemo(() => summarizePlacementReview(results), [results]);
  if (!summary) return null;
  const { totals } = summary;
  const nothingToReview =
    totals.notPlaced === 0 && totals.needsReview === 0 && totals.unchecked === 0;
  // Said only when the run carries its rosters and someone is on them: a run that cannot tell
  // says nothing rather than a falsely perfect result.
  const allChecked =
    summary.divisions.some((review) => review.placedCount > 0) &&
    summary.divisions.every((review) => review.rostersKnown);
  if (nothingToReview && !allChecked) return null;

  return (
    <section
      className="bg-bg-surface border border-border-subtle rounded-xl p-6"
      aria-labelledby="placement-review-heading"
    >
      <h3 id="placement-review-heading" className="text-xl font-bold text-text-primary mb-2">
        Players to review
      </h3>
      {nothingToReview && (
        <p className="text-sm text-text-secondary">
          Every player is placed, and each one&apos;s age was checked against the division.
        </p>
      )}
      {summary.divisions.map((review) => {
        const { division, notPlaced, needsReview, unchecked } = review;
        if (notPlaced.length === 0 && needsReview.length === 0 && unchecked.length === 0) {
          return null;
        }
        const notEligible = notPlaced.filter(
          (e) => e.reason === TEAM_GENERATION.REASON_EligibilityBlocked
        ).length;
        const otherReason = notPlaced.length - notEligible;
        return (
          <div key={division} className="space-y-4">
            <p className="text-sm text-text-secondary">
              {division}: {notPlaced.length} not placed ({notEligible} not eligible for the
              division, {otherReason} for another reason), {needsReview.length} needing review,{' '}
              {unchecked.length} with eligibility not checked.
            </p>
            {notPlaced.length > 0 && (
              <section aria-labelledby={anchorId(division, 'not-placed')}>
                <h4
                  id={anchorId(division, 'not-placed')}
                  className="font-semibold text-text-primary"
                >
                  Not placed
                </h4>
                <ul className="text-sm text-text-secondary list-disc pl-5">
                  {notPlaced.map((entry, index) => (
                    <li key={`${entry.playerId}:${index}`}>
                      <span className="font-medium text-text-primary">{entry.name}</span>.{' '}
                      {notPlacedText(entry)} {ageText(entry.naturalAge)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {needsReview.length > 0 && (
              <section aria-labelledby={anchorId(division, 'needs-review')}>
                <h4
                  id={anchorId(division, 'needs-review')}
                  className="font-semibold text-text-primary"
                >
                  Needs review
                </h4>
                <ul className="text-sm text-text-secondary list-disc pl-5">
                  {needsReview.map((entry) => (
                    <li key={entry.playerId}>
                      <span className="font-medium text-text-primary">{entry.name}</span>, on{' '}
                      {entry.teamName ?? 'no team'}.{' '}
                      {eligibilityText(entry.placement, entry.reviewReason)} Kept on the reviewed
                      roster; move them by hand if you agree.
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {unchecked.length > 0 && (
              <section aria-labelledby={anchorId(division, 'unchecked')}>
                <h4
                  id={anchorId(division, 'unchecked')}
                  className="font-semibold text-text-primary"
                >
                  Eligibility not checked
                </h4>
                <p className="text-sm text-text-secondary">
                  Placed, with no birthdate or division age band to check against. Nothing holds
                  them off a roster.
                </p>
                <ul className="text-sm text-text-secondary list-disc pl-5">
                  {unchecked.map((entry) => (
                    <li key={entry.playerId}>
                      <span className="font-medium text-text-primary">{entry.name}</span>{' '}
                      <span className="text-xs font-semibold rounded-full px-2 py-0.5 border bg-status-warning-bg border-status-warning/30 text-status-warning-text">
                        Eligibility not checked
                      </span>
                      {entry.teamName ? ` on ${entry.teamName}.` : '.'}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        );
      })}
    </section>
  );
}

PlacementReviewList.propTypes = {
  results: PropTypes.shape({
    teamsByDivision: PropTypes.object,
    overflowByDivision: PropTypes.object,
    changeDiagnosticsByDivision: PropTypes.object,
    team_players: PropTypes.arrayOf(PropTypes.object),
    teams: PropTypes.arrayOf(PropTypes.object),
  }),
};
