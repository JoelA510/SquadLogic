/**
 * The Teams page's placement review (Phase B3, docs/changes/2026-10-22-phase-b-teaming.md): the
 * pure summary of a run's `results` and the list that shows it. The page path (a real run
 * through the pipeline and the generator) is `teamAnalysisEligibility.test.jsx`; this file holds
 * the edges a run of today's generator does not produce on demand: a reason the list has no
 * words for, capacity beside eligibility, a manual move after a hold, a run without its rosters.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PlacementReviewList from '../frontend/src/components/teaming/PlacementReviewList.jsx';
import BuddyRequestsList from '../frontend/src/components/teaming/BuddyRequestsList.jsx';
import {
  notPlacedById,
  placementReviewAnnouncement,
  summarizePlacementReview,
} from '../frontend/src/utils/placementReview.js';

const player = (id, extra = {}) => ({ id, name: `Player ${id.toUpperCase()}`, ...extra });
const inBand = (id) => player(id, { placement: 'in_band', naturalAge: 10 });

/**
 * A run of two teams in U10, as `buildTeamReviewSnapshot` stores it.
 * @param {{ teamA?: any[], teamB?: any[], overflow?: any[], holds?: any[], rows?: any[] }} [parts]
 */
function run({ teamA = [], teamB = [], overflow = [], holds, rows } = {}) {
  const teams = [
    { id: 'team-a', name: 'Team A', division: 'U10', players: teamA },
    { id: 'team-b', name: 'Team B', division: 'U10', players: teamB },
  ];
  return {
    teamsByDivision: { U10: teams },
    overflowByDivision: { U10: overflow },
    ...(holds ? { changeDiagnosticsByDivision: { U10: { eligibilityHolds: holds } } } : {}),
    teams: teams.map(({ id, name, division }) => ({ id, name, division })),
    team_players:
      rows ??
      teams.flatMap((team) =>
        team.players.map((p) => ({
          team_id: team.id,
          player_id: p.id,
          role: 'player',
          player_name: p.name,
        }))
      ),
  };
}

const list = (name) => screen.getByRole('region', { name });
const itemsOf = (name) => within(list(name)).getAllByRole('listitem');

describe('placement review :: not placed', () => {
  it('lists capacity and eligibility apart, and never reports room as eligibility', () => {
    const results = run({
      teamA: [inBand('a')],
      overflow: [
        {
          players: [player('x', { placement: 'play_down_blocked', naturalAge: 13 })],
          reason: 'eligibility-blocked',
          metadata: {
            placement: 'play_down_blocked',
            reviewReason: 'play-down is not permitted',
            naturalAge: 13,
            coachId: null,
          },
        },
        { players: [inBand('y'), inBand('z')], reason: 'insufficient-capacity' },
      ],
    });
    render(<PlacementReviewList results={results} />);

    const items = itemsOf('Not placed');
    expect(items.map((item) => item.textContent)).toEqual([
      'Player X. Not eligible for this division. Older than the division allows, and playing down is not permitted. Natural age 13.',
      'Player Y. No room: the teams were full. Natural age 10.',
      'Player Z. No room: the teams were full. Natural age 10.',
    ]);
    expect(
      screen.getByText(
        /^U10: 3 not placed \(1 not eligible for the division, 2 for another reason\)/
      )
    ).toBeInTheDocument();
    expect(placementReviewAnnouncement(summarizePlacementReview(results))).toBe(
      'Players to review: 3 players not placed (1 not eligible for the division, 2 for another reason).'
    );
  });

  it('shows a reason it has no words for as the generator recorded it, never drops it', () => {
    const results = run({
      teamA: [inBand('a')],
      overflow: [
        { players: [player('m')], reason: 'some-future-reason' },
        { players: [player('n')] },
      ],
    });
    render(<PlacementReviewList results={results} />);

    expect(itemsOf('Not placed').map((item) => item.textContent)).toEqual([
      'Player M. Not placed (reason recorded: “some-future-reason”). Natural age unknown.',
      'Player N. Not placed (reason recorded: “unknown”). Natural age unknown.',
    ]);
  });

  it('words an eligibility block it has no sentence for from its review reason', () => {
    const results = run({
      teamA: [inBand('a')],
      overflow: [
        {
          players: [player('q')],
          reason: 'eligibility-blocked',
          metadata: { placement: 'some_new_block', reviewReason: 'a new rule', naturalAge: null },
        },
      ],
    });
    render(<PlacementReviewList results={results} />);
    expect(itemsOf('Not placed')[0]).toHaveTextContent(
      'Player Q. Not eligible for this division. A new rule. Natural age unknown.'
    );
  });
});

describe('placement review :: a not-placed player moved by hand', () => {
  it('stays listed, and says where they are now', () => {
    const results = run({
      teamA: [inBand('a')],
      overflow: [{ players: [inBand('y')], reason: 'insufficient-capacity' }],
      rows: [
        { team_id: 'team-a', player_id: 'a', role: 'player', player_name: 'Player A' },
        { team_id: 'team-b', player_id: 'y', role: 'player', player_name: 'Player Y' },
      ],
    });
    render(<PlacementReviewList results={results} />);
    expect(itemsOf('Not placed')[0]).toHaveTextContent(
      'Player Y. No room: the teams were full. Natural age 10. Since placed by hand on Team B.'
    );
    // Their check came with them: in the band, so not flagged as unchecked.
    expect(screen.queryByRole('region', { name: 'Eligibility not checked' })).toBeNull();
  });
});

describe('placement review :: needs review', () => {
  const blocked = (id) =>
    player(id, {
      placement: 'play_up_blocked',
      reviewReason: 'unsanctioned play-up (no coaching parent or qualifying buddy)',
      division: 'U10',
      registeredDivision: 'U10',
    });

  it('names the team a held player is on now, after a manual move', () => {
    const results = run({
      teamA: [blocked('h'), inBand('a')],
      teamB: [inBand('b')],
      holds: [
        { playerId: 'h', teamId: 'team-a', placement: 'play_up_blocked', reviewReason: null },
      ],
      // The admin moved the held player to Team B by hand.
      rows: [
        { team_id: 'team-b', player_id: 'h', role: 'player', player_name: 'Player H' },
        { team_id: 'team-a', player_id: 'a', role: 'player', player_name: 'Player A' },
        { team_id: 'team-b', player_id: 'b', role: 'player', player_name: 'Player B' },
      ],
    });
    render(<PlacementReviewList results={results} />);
    expect(placementReviewAnnouncement(summarizePlacementReview(results))).toBe(
      'Players to review: 1 player needs review.'
    );

    expect(itemsOf('Needs review').map((item) => item.textContent)).toEqual([
      "Player H, on Team B. Not eligible for this division. Younger than the division allows, with no coaching parent or coach's child as a buddy to sanction playing up. Kept on the reviewed roster; move them by hand if you agree.",
    ]);
  });

  it('lists a blocked player found on a roster even when the holds do not name them', () => {
    const results = run({ teamA: [blocked('h'), inBand('a')], holds: [] });
    const summary = summarizePlacementReview(results);
    expect(summary?.divisions[0].needsReview.map((entry) => entry.playerId)).toEqual(['h']);
  });
});

describe('placement review :: eligibility not checked', () => {
  it('flags each placed player whose placement is not a passed check, beside their name', () => {
    const results = run({
      teamA: [inBand('a'), player('u', { placement: 'unknown' })],
      teamB: [player('s', { placement: 'play_up_sanctioned' }), player('w')],
    });
    render(<PlacementReviewList results={results} />);

    expect(itemsOf('Eligibility not checked').map((item) => item.textContent)).toEqual([
      'Player U Eligibility not checked on Team A.',
      // No placement recorded at all is not a check either.
      'Player W Eligibility not checked on Team B.',
    ]);
    expect(screen.queryByRole('region', { name: 'Not placed' })).toBeNull();
  });

  it('says every player was checked only when it can tell', () => {
    const { unmount } = render(
      <PlacementReviewList results={run({ teamA: [inBand('a')], teamB: [inBand('b')] })} />
    );
    expect(
      screen.getByText(
        "Every player is placed, and each one's age was checked against the division."
      )
    ).toBeInTheDocument();
    unmount();

    // A run that carries no generated rosters (a seeded or old run): no claim, no list.
    const { container } = render(
      <PlacementReviewList
        results={{
          teams: [{ id: 'team-a', name: 'Team A', division: 'U10' }],
          team_players: [{ team_id: 'team-a', player_id: 'a', role: 'player' }],
        }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing and announces nothing for no run', () => {
    const { container } = render(<PlacementReviewList results={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(placementReviewAnnouncement(summarizePlacementReview(undefined))).toBe('');
    expect(
      placementReviewAnnouncement(summarizePlacementReview(run({ teamA: [inBand('a')] })))
    ).toBe('');
  });
});

describe('Buddy requests :: why a pair is apart', () => {
  it('names the buddy who is not placed, and why', () => {
    const results = {
      ...run({
        teamA: [inBand('b')],
        overflow: [
          { players: [player('a')], reason: 'eligibility-blocked', metadata: {} },
          { players: [player('c')], reason: 'insufficient-capacity' },
        ],
      }),
      buddyRequestsByDivision: {
        U10: {
          rule: 'mutual',
          paired: [
            { playerIds: ['a', 'b'], names: ['Player A', 'Player B'], together: false },
            { playerIds: ['c', 'b'], names: ['Player C', 'Player B'], together: false },
          ],
          oneWay: [],
          unresolved: [],
        },
      },
    };
    expect(notPlacedById(results).get('a')).toEqual({
      reason: 'eligibility-blocked',
      name: 'Player A',
    });
    render(<BuddyRequestsList results={results} />);

    expect(itemsOf('Paired').map((item) => item.textContent)).toEqual([
      'Player A and Player B. Not placed together: Player A is not eligible for this division and is not placed.',
      'Player C and Player B. Not placed together: Player C is not placed.',
    ]);
  });
});
