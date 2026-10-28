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
  coachIdsNamedByReview,
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
          players: [player('x', { placement: 'no_division', naturalAge: 13 })],
          reason: 'eligibility-blocked',
          metadata: {
            placement: 'no_division',
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
      'Player X. Not eligible for this division. No division in this import holds a player of their age. Natural age 13.',
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

describe('placement review :: needs review', () => {
  const blocked = (id) =>
    player(id, {
      placement: 'no_division',
      reviewReason: 'no division holds natural age 8',
      division: 'U10',
      registeredDivision: 'U10',
    });

  it('names the team a held player is on now, after a manual move', () => {
    const results = run({
      teamA: [blocked('h'), inBand('a')],
      teamB: [inBand('b')],
      holds: [{ playerId: 'h', teamId: 'team-a', placement: 'no_division', reviewReason: null }],
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
      'Player H, on Team B. Not eligible for this division. No division in this import holds a player of their age. Kept on the reviewed roster; move them by hand if you agree.',
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
      teamB: [player('s', { placement: 'play_up' }), player('w')],
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

  it('flags nobody when the rosters hold no player records (rebuilt from team rows)', () => {
    // `buildManualRosterSnapshot` rebuilds `teamsByDivision` from team rows with empty `players`
    // when the run had none: the rows say who is placed, nothing says who was checked.
    const results = {
      teamsByDivision: { U10: [{ id: 'team-a', name: 'Team A', division: 'U10', players: [] }] },
      teams: [{ id: 'team-a', name: 'Team A', division: 'U10' }],
      team_players: [{ team_id: 'team-a', player_id: 'a', role: 'player' }],
    };
    const { container } = render(<PlacementReviewList results={results} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads coach rows out of the roster, by the persistence module's role rule", () => {
    const results = run({ teamA: [inBand('a')] });
    results.team_players.push(
      { team_id: 'team-a', player_id: 'coach-1', role: 'Head Coach' },
      { team_id: 'team-a', player_id: 'b', role: 'Player' }
    );
    const summary = summarizePlacementReview(results);
    // The coach is not a placed player; a capitalised "Player" row is.
    expect(summary?.divisions[0].placedCount).toBe(2);
    expect(summary?.divisions[0].unchecked.map((entry) => entry.playerId)).toEqual(['b']);
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
    // A player the current rows seat is not reported as not placed.
    expect(
      notPlacedById({
        ...results,
        team_players: [...results.team_players, { team_id: 'team-b', player_id: 'c' }],
      }).has('c')
    ).toBe(false);
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

// Owner decisions of 2026-10-27: a coach with no team to anchor, and a coach with more than one
// child in a division (docs/changes/2026-10-22-phase-b-teaming.md, "Owner decisions").
describe('placement review :: coaches', () => {
  const child = (id, coachId, extra = {}) =>
    player(id, { coachId, placement: 'in_band', naturalAge: 10, ...extra });
  const NAMES = { coachNamesById: { k1: 'Casey Coach' } };

  it('a waitlisted only child leaves the coach with no team, and the list says why', () => {
    const results = {
      ...run({
        teamA: [inBand('a')],
        overflow: [
          {
            players: [child('w', 'k1', { status: 'waitlist' })],
            reason: 'waitlisted',
            metadata: { coachId: 'k1' },
          },
        ],
      }),
      ...NAMES,
    };
    render(<PlacementReviewList results={results} />);
    expect(itemsOf('Not placed').map((item) => item.textContent)).toEqual([
      'Player W. On the waitlist: not placed on any team. Natural age 10. Coach Casey Coach has no team to anchor in this division: Player W, their only child in it, is on the waitlist.',
    ]);
    expect(screen.getByText(/^U10: 1 not placed/)).toHaveTextContent(
      '1 not placed (0 not eligible for the division, 1 on the waitlist, 0 for another reason), 0 needing review, 0 with eligibility not checked, 1 coach with no team to anchor.'
    );
  });

  it('a coach who anchors a team is not "without a team" for a held-out child', () => {
    const results = run({
      teamA: [player('a', { coachId: 'k1', placement: 'in_band' })],
      overflow: [
        {
          players: [child('w', 'k1', { status: 'waitlist' })],
          reason: 'waitlisted',
          metadata: { coachId: 'k1' },
        },
      ],
    });
    results.teamsByDivision.U10[0].coachId = 'k1';
    const summary = summarizePlacementReview(results);
    expect(summary?.divisions[0].notPlaced[0].coachWithoutTeam).toBeNull();
    expect(summary?.totals.coachesWithoutTeam).toBe(0);
  });

  it('a run without its teams cannot say who has a team, so it flags no coach', () => {
    const results = {
      overflowByDivision: {
        U10: [{ players: [child('w', 'k1')], reason: 'waitlisted', metadata: { coachId: 'k1' } }],
      },
    };
    const summary = summarizePlacementReview(results);
    expect(summary?.divisions[0].notPlaced).toHaveLength(1);
    expect(summary?.divisions[0].notPlaced[0].coachWithoutTeam).toBeNull();
  });

  it('a coach row with no name on file is still flagged, and counted; a row-named coach labels itself', () => {
    const UUID = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c91';
    const overflowFor = (coachId) => [
      {
        players: [child('w', coachId)],
        reason: 'eligibility-blocked',
        metadata: { coachId },
      },
    ];
    const results = run({ teamA: [inBand('a')], overflow: overflowFor(UUID) });
    const summary = summarizePlacementReview(results);
    expect(summary?.divisions[0].notPlaced[0].coachWithoutTeam).toEqual({
      coachId: UUID,
      name: null,
    });
    expect(coachIdsNamedByReview(summary)).toEqual([UUID]);
    const { unmount } = render(<PlacementReviewList results={results} />);
    expect(
      screen.getByText(/A coach \(name not loaded\) has no team to anchor/)
    ).toBeInTheDocument();
    unmount();

    // The import row's own text is the label, and nothing is read for it.
    const rowCoach = run({ teamA: [inBand('a')], overflow: overflowFor('ann@coaches.test') });
    const rowSummary = summarizePlacementReview(rowCoach);
    expect(rowSummary?.divisions[0].notPlaced[0].coachWithoutTeam).toEqual({
      coachId: 'ann@coaches.test',
      name: 'ann@coaches.test',
    });
    expect(coachIdsNamedByReview(rowSummary)).toEqual([]);
    render(<PlacementReviewList results={rowCoach} />);
    expect(screen.getByText(/Coach ann@coaches.test has no team to anchor/)).toBeInTheDocument();
  });

  it('children of one coach on different teams (a manual move) are flagged apart, where they are now', () => {
    const results = {
      ...run({
        teamA: [child('s1', 'k1'), child('s2', 'k1')],
        // The admin moved s2 to Team B in the roster editor: the run's rows say so.
        rows: [
          { team_id: 'team-a', player_id: 's1', role: 'player', player_name: 'Player S1' },
          { team_id: 'team-b', player_id: 's2', role: 'player', player_name: 'Player S2' },
        ],
      }),
      ...NAMES,
    };
    const summary = summarizePlacementReview(results);
    expect(summary?.divisions[0].siblings).toEqual([
      {
        coachId: 'k1',
        name: 'Casey Coach',
        together: false,
        children: [
          { playerId: 's1', name: 'Player S1', teamName: 'Team A', notPlacedReason: null },
          { playerId: 's2', name: 'Player S2', teamName: 'Team B', notPlacedReason: null },
        ],
      },
    ]);
    expect(placementReviewAnnouncement(summary)).toBe(
      'Players to review: 1 coach has more than one child in a division (1 not together).'
    );
    render(<PlacementReviewList results={results} />);
    expect(itemsOf('Coaches with more than one child').map((item) => item.textContent)).toEqual([
      'Coach Casey Coach: Player S1, on Team A; Player S2, on Team B. They are not on the same team.',
    ]);
  });

  it('three children, two of them buddies, are still flagged; two buddies are not', () => {
    const buddies = (a, b) => [child(a, 'k1', { buddyId: b }), child(b, 'k1', { buddyId: a })];
    const two = summarizePlacementReview(run({ teamA: buddies('s1', 's2') }));
    expect(two?.divisions[0].siblings).toEqual([]);
    const three = summarizePlacementReview(
      run({ teamA: [...buddies('s1', 's2'), child('s3', 'k1')] })
    );
    expect(three?.divisions[0].siblings).toHaveLength(1);
    expect(three?.divisions[0].siblings[0].together).toBe(true);
  });

  it('a coach with one child per division is not flagged', () => {
    const results = run({ teamA: [child('s1', 'k1')], teamB: [child('s2', 'k2')] });
    expect(summarizePlacementReview(results)?.divisions[0].siblings).toEqual([]);
  });
});
