/**
 * Who moved, on the overview and in the settings sentence (play-down plan, 2026-11-03, PR 1, task
 * A3). The advice counts a player in the division they PLAY in, so the Players cell carries two muted
 * notes that reconcile the file's count with it: players registered elsewhere who play here, and
 * players registered here who play in their own age division. They appear only when they are not
 * zero; a division where nobody moved reads byte for byte as it did before. The page tests
 * (`teamingConfigurationAdvice.test.jsx`) show the numbers from real rows; this file holds the
 * components to the words and to the "only when not zero" rule, with every figure written here.
 */
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProgramOverview from '../frontend/src/components/teaming/ProgramOverview.jsx';
import TeamingConfiguration from '../frontend/src/components/teaming/TeamingConfiguration.jsx';
import { movedAwayNote, movedHereNote } from '../frontend/src/utils/seatNotes.js';

afterEach(() => cleanup());

const assessment = (recommendedTeamCount) => ({
  blocked: false,
  teamCount: recommendedTeamCount,
  recommendedTeamCount,
  fitRange: null,
  smallestTeam: null,
  largestTeam: null,
  warnings: [],
});

/** A division row as the page builds it, with what each test sets. */
const program = (id, extra = {}) => ({
  id,
  name: id,
  playerCount: 24,
  waitlistedCount: 0,
  notEligibleCount: 0,
  movedInCount: 0,
  movedOutCount: 0,
  estimatedTeams: 2,
  avgRosterSize: 12,
  assessment: assessment(2),
  ...extra,
});

function renderOverview(programs) {
  render(
    <ProgramOverview programs={programs} onSelectProgram={vi.fn()} selectedProgramId={null} />
  );
}

/** The Players cell of a division's row. */
function playersCell(name) {
  const row = /** @type {HTMLElement} */ (screen.getByRole('button', { name }).closest('tr'));
  return within(row).getAllByRole('cell')[1];
}

describe('the notes beside a division’s Players count', () => {
  it('has the words of the plan, singular and plural', () => {
    expect(movedHereNote(2)).toBe('2 moved here from other divisions');
    expect(movedHereNote(1)).toBe('1 moved here from another division');
    expect(movedAwayNote(3)).toBe('3 registered here, placed in their own age division');
    expect(movedAwayNote(1)).toBe('1 registered here, placed in their own age division');
  });

  it('shows both notes under the count, only when they are not zero', () => {
    renderOverview([
      program('U10', { playerCount: 24, movedOutCount: 6 }),
      program('U12', { playerCount: 30, movedInCount: 6 }),
      program('U14', { playerCount: 20, movedInCount: 1, movedOutCount: 2 }),
    ]);
    expect(playersCell('U10')).toHaveTextContent(
      /^24\s*6 registered here, placed in their own age division$/
    );
    expect(playersCell('U12')).toHaveTextContent(/^30\s*6 moved here from other divisions$/);
    expect(playersCell('U14')).toHaveTextContent(
      /^20\s*1 moved here from another division\s*2 registered here, placed in their own age division$/
    );
  });

  it('reads byte for byte as before when nobody moved', () => {
    renderOverview([program('U10', { playerCount: 30 })]);
    expect(playersCell('U10').textContent).toBe('30');
    expect(screen.queryByText(/moved here|placed in their own age division/)).toBeNull();
    // A row from a caller that has never heard of the counts reads the same.
    cleanup();
    const {
      movedInCount: _in,
      movedOutCount: _out,
      ...before
    } = program('U10', { playerCount: 30 });
    renderOverview([before]);
    expect(playersCell('U10').textContent).toBe('30');
  });

  it('puts the notes after the waitlist and not-eligible lines, each on its own line', () => {
    renderOverview([
      program('U12', {
        playerCount: 28,
        waitlistedCount: 2,
        notEligibleCount: 1,
        movedInCount: 6,
      }),
    ]);
    expect(playersCell('U12')).toHaveTextContent(
      /^28\s*2 on the waitlist\s*1 not eligible\s*6 moved here from other divisions$/
    );
    const lines = within(playersCell('U12'))
      .getAllByText(/waitlist|not eligible|moved here/)
      .map((node) => node.tagName);
    expect(lines).toEqual(['SPAN', 'SPAN', 'SPAN']);
  });
});

describe('the status of a division nobody is left to seat in', () => {
  const statusOf = (name) => {
    const row = /** @type {HTMLElement} */ (screen.getByRole('button', { name }).closest('tr'));
    return within(row).getAllByRole('cell')[5];
  };
  const empty = {
    playerCount: 0,
    estimatedTeams: 0,
    avgRosterSize: 0,
    assessment: assessment(null),
  };

  it('says all were placed in other divisions, never that it fits the limits', () => {
    renderOverview([program('U10', { ...empty, movedOutCount: 12 })]);
    expect(statusOf('U10')).toHaveTextContent('All placed in other divisions');
    expect(statusOf('U10')).not.toHaveTextContent('Fits the limits');
  });

  it('keeps the three older statuses, and calls any mix with a move "Nobody to seat"', () => {
    renderOverview([
      program('A', { ...empty, waitlistedCount: 12 }),
      program('B', { ...empty, notEligibleCount: 12 }),
      program('C', { ...empty, waitlistedCount: 6, notEligibleCount: 6 }),
      program('D', { ...empty, waitlistedCount: 6, movedOutCount: 6 }),
      program('E', { ...empty, notEligibleCount: 6, movedOutCount: 6 }),
    ]);
    expect(statusOf('A')).toHaveTextContent('All on the waitlist');
    expect(statusOf('B')).toHaveTextContent('None eligible');
    expect(statusOf('C')).toHaveTextContent('Nobody to seat');
    expect(statusOf('D')).toHaveTextContent('Nobody to seat');
    expect(statusOf('E')).toHaveTextContent('Nobody to seat');
  });

  it('does not say it for a division that still has players', () => {
    renderOverview([program('U10', { playerCount: 12, movedOutCount: 6 })]);
    expect(statusOf('U10')).toHaveTextContent('Fits the limits');
  });
});

describe('the settings sentence says who moved, in the same words', () => {
  const limits = { targetTeamSize: 12, minRosterSize: 10, maxRosterSize: 14 };
  const sentence = (extra) => {
    render(
      <TeamingConfiguration
        program={{ id: 'U12', name: 'U12', playerCount: 30, estimatedTeams: 3, ...extra }}
        config={limits}
        onUpdate={vi.fn()}
        onSave={vi.fn()}
      />
    );
    return screen.getByTestId('team-count-recommendation');
  };

  it('adds one parenthesis for the moves, after the waitlist note', () => {
    expect(sentence({ movedInCount: 6 })).toHaveTextContent(
      'Recommended: 3 teams for 30 players (6 moved here from other divisions)'
    );
    cleanup();
    expect(sentence({ playerCount: 24, movedOutCount: 6 })).toHaveTextContent(
      'Recommended: 2 teams for 24 players (6 registered here, placed in their own age division)'
    );
    cleanup();
    expect(
      sentence({ playerCount: 28, waitlistedCount: 2, movedInCount: 1, movedOutCount: 3 })
    ).toHaveTextContent(
      'Recommended: 2 teams for 28 players (2 on the waitlist are not counted) (1 moved here from another division; 3 registered here, placed in their own age division)'
    );
  });

  it('is exactly the old sentence when nobody moved', () => {
    expect(sentence({ movedInCount: 0, movedOutCount: 0 })).toHaveTextContent(
      /^Recommended: 3 teams for 30 players\. Each volunteer head coach gets a team, which can add more\.$/
    );
    cleanup();
    expect(sentence({})).toHaveTextContent(
      /^Recommended: 3 teams for 30 players\. Each volunteer head coach gets a team, which can add more\.$/
    );
  });
});
