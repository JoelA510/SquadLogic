/**
 * The Teams page's "Team sizes" section (Phase B4, docs/changes/2026-10-22-phase-b-teaming.md):
 * a run's outcome against its roster limits, beside its counts, read from the run's `results` as
 * `buildTeamReviewSnapshot` stores them. The page path (a generation that stages the review) is
 * in `teamingConfigurationAdvice.test.jsx`; this file holds the reruns and the edges. Results are
 * the real generator's; expected counts come from the inputs.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import TeamSizeOutcomeList from '../frontend/src/components/teaming/TeamSizeOutcomeList.jsx';
import {
  summarizeTeamSizeReview,
  teamSizeAnnouncement,
} from '../frontend/src/utils/teamSizeReview.js';
import { buildTeamReviewSnapshot } from '../frontend/src/utils/teamReviewPersistence.js';
import { createDeterministicRandom } from './fixtures/incrementalTeamingFixtures.js';

const players = (count, prefix = 'p') =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    division: 'U10',
    name: `Player ${prefix.toUpperCase()}${index + 1}`,
  }));

/** The stored `results` of a run, as the page stages it. */
function stored(result, config) {
  return buildTeamReviewSnapshot({
    generatedResult: result,
    divisionKey: 'U10',
    divisionId: '00000000-0000-4000-8000-000000000010',
    organizationId: 'org-1',
    seasonSettingsId: 'season-1',
    userId: 'user-1',
    selectedProgramId: 'U10',
    divisionConfig: { id: 'U10', ...config },
  }).runMetadata.results;
}

const fresh = (count, config) =>
  stored(
    generateTeams({
      players: players(count),
      divisionConfigs: { U10: { id: 'U10', ...config } },
      random: createDeterministicRandom(),
    }),
    config
  );

/** A rerun onto three saved teams already at the maximum of four, over-cap placement allowed. */
function overCapRerun() {
  const saved = (n, ids) => ({
    id: `00000000-0000-4000-8000-00000000010${n}`,
    name: `Team ${n}`,
    division: 'U10',
    players: ids.map((id) => ({ id })),
  });
  /** @type {any} */
  const config = { maxRosterSize: 4 };
  const result = generateTeams({
    players: [...players(12, 's'), { id: 'late-1', division: 'U10', name: 'Late One' }],
    divisionConfigs: { U10: { id: 'U10', ...config } },
    random: createDeterministicRandom(),
    existingSnapshot: {
      status: 'published',
      runId: 'run-1',
      teamsByDivision: {
        U10: [
          saved(1, ['s1', 's2', 's3', 's4']),
          saved(2, ['s5', 's6', 's7', 's8']),
          saved(3, ['s9', 's10', 's11', 's12']),
        ],
      },
    },
    generationMode: 'published',
    changePolicy: { allowOverCapAssignments: true },
  });
  return stored(result, config);
}

const section = () => screen.getByRole('region', { name: 'Team sizes' });
const warnings = () => within(section()).queryByRole('list', { name: 'U10 team-size warnings' });

describe('Team sizes on the Teams page', () => {
  it('names the team a rerun pushed over the maximum, and announces it', () => {
    const results = overCapRerun();
    render(<TeamSizeOutcomeList results={results} />);
    // Thirteen players on three teams of at most four.
    expect(section()).toHaveTextContent('U10: 3 teams, 13 players placed.');
    expect(warnings()).toHaveTextContent(
      /^1 team over the maximum of 4: Team [123] \(5 players\)\.$/
    );
    expect(teamSizeAnnouncement(summarizeTeamSizeReview(results))).toBe(
      'Team sizes: 1 team over the maximum roster.'
    );
  });

  it('says how many were not placed for lack of room and why, and points to the list of who', () => {
    // Thirty players, at most two teams of ten.
    const results = fresh(30, { maxRosterSize: 10, maxTeams: 2 });
    render(<TeamSizeOutcomeList results={results} />);
    expect(warnings()).toHaveTextContent(
      `${30 - 2 * 10} players not placed for lack of room (${30 - 2 * 10}: the teams were full). Each is listed under "Not placed" in Players to review.`
    );
    expect(teamSizeAnnouncement(summarizeTeamSizeReview(results))).toBe(
      'Team sizes: 10 players not placed for lack of room.'
    );
  });

  it('says every team fits only when the run recorded the limits it was checked against', () => {
    const results = fresh(20, { maxRosterSize: 10, minRosterSize: 8 });
    const { unmount } = render(<TeamSizeOutcomeList results={results} />);
    expect(section()).toHaveTextContent('Rosters of 8 to 10 players.');
    expect(section()).toHaveTextContent('Every team is within the roster limits');
    expect(warnings()).toBeNull();
    expect(teamSizeAnnouncement(summarizeTeamSizeReview(results))).toBe('');
    unmount();

    // The same run without its recorded limits, and no rerun check: not checked, never "fits".
    const { rosterBalanceByDivision: _limits, ...unrecorded } = results;
    render(<TeamSizeOutcomeList results={unrecorded} />);
    expect(section()).not.toHaveTextContent('Every team is within');
    expect(warnings()).toHaveTextContent(
      'This run did not record its roster limits, so team sizes were not checked against them.'
    );
    expect(teamSizeAnnouncement(summarizeTeamSizeReview(unrecorded))).toBe(
      'Team sizes: 1 division not checked against the limits.'
    );
  });

  it("counts a team's players from the run's current rows, leaving out coach rows", () => {
    const results = fresh(10, { maxRosterSize: 10, minRosterSize: 8 });
    const [team] = results.teamsByDivision.U10;
    // A manual edit left seven players and a coach row on the team.
    const edited = {
      ...results,
      team_players: [
        ...results.team_players.slice(0, 7),
        { team_id: team.id, player_id: 'coach-1', role: 'coach' },
      ],
    };
    render(<TeamSizeOutcomeList results={edited} />);
    expect(warnings()).toHaveTextContent(
      `1 team under the minimum of 8: ${team.name} (7 players).`
    );
  });

  it('shows nothing for a run without rosters', () => {
    const { container } = render(<TeamSizeOutcomeList results={{ team_players: [] }} />);
    expect(container).toBeEmptyDOMElement();
    expect(teamSizeAnnouncement(summarizeTeamSizeReview(undefined))).toBe('');
  });
});
