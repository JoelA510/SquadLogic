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
import {
  askedToPlayUpNote,
  flagCountsOf,
  flagLines,
  flagSummary,
  movedAwayNote,
  movedHereNote,
  movedInFromProgramsNote,
} from '../frontend/src/utils/seatNotes.js';

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

function renderOverview(programs, extra = {}) {
  render(
    <ProgramOverview
      programs={programs}
      onSelectProgram={vi.fn()}
      selectedProgramId={null}
      {...extra}
    />
  );
}

/** A cell of a division's row, by its column header (a new column moves the others along). */
function cellOf(name, header) {
  const row = /** @type {HTMLElement} */ (screen.getByRole('button', { name }).closest('tr'));
  const table = /** @type {HTMLElement} */ (row.closest('table'));
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((th) => th.textContent);
  expect(headers).toContain(header);
  return within(row).getAllByRole('cell')[headers.indexOf(header)];
}
/** The Players cell of a division's row. */
const playersCell = (name) => cellOf(name, 'Players');

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
    // In the table: the caption above it says in a sentence what happens to a player registered in a
    // younger division, which is not a note beside a count.
    expect(
      within(screen.getByRole('table')).queryByText(/moved here|placed in their own age division/)
    ).toBeNull();
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
  const statusOf = (name) => cellOf(name, 'Status');
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
    expect(sentence({ playerCount: 24, movedOutCount: 1 })).toHaveTextContent(
      'Recommended: 2 teams for 24 players (1 registered here is placed in their own age division and not counted)'
    );
    cleanup();
    expect(sentence({ movedInCount: 6 })).toHaveTextContent(
      'Recommended: 3 teams for 30 players (6 moved here from other divisions)'
    );
    cleanup();
    expect(sentence({ playerCount: 24, movedOutCount: 6 })).toHaveTextContent(
      'Recommended: 2 teams for 24 players (6 registered here are placed in their own age division and not counted)'
    );
    cleanup();
    expect(
      sentence({ playerCount: 28, waitlistedCount: 2, movedInCount: 1, movedOutCount: 3 })
    ).toHaveTextContent(
      'Recommended: 2 teams for 28 players (2 on the waitlist are not counted) (1 moved here from another division; 3 registered here are placed in their own age division and not counted)'
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

/*
 * Play-down plan, PR 2: every play-up and play-down is flagged and counted. The page tests
 * (`teamingConfigurationAdvice.test.jsx`, "flags every play-up and play-down") get the numbers from
 * real rows; this file holds the component to its words: a count that is zero says "None" and an
 * unknown says "not checked", and neither is ever the other (lesson 47, both directions).
 */
/** The counts of a division, as `flagCountsOf` gives them, with what each test sets. */
const flags = (extra = {}, checked = true) =>
  flagCountsOf(
    { playingUp: 0, playingDown: 0, askedToPlayUp: 0, notChecked: 0, movedIn: 0, ...extra },
    checked
  );

describe('the Play-up and play-down column', () => {
  const flagCell = (name) => cellOf(name, 'Play-up and play-down');

  it('is a real column header, and says in words who plays up or down', () => {
    renderOverview([program('U10', { flags: flags({ playingUp: 2, playingDown: 1 }) })]);
    expect(screen.getByRole('columnheader', { name: 'Play-up and play-down' })).toBeInTheDocument();
    expect(flagCell('U10')).toHaveTextContent(/^2 playing up\s*1 playing down$/);
  });

  it('reads "None" for a division where nobody plays up or down, never a blank', () => {
    renderOverview([program('U10', { flags: flags() })]);
    expect(flagCell('U10').textContent).toBe('None');
  });

  it('reads "not checked" for a seat nothing could be compared with, never "None"', () => {
    renderOverview([
      program('A', { flags: flags({ notChecked: 3 }) }),
      program('B', { flags: flags({ playingUp: 1, notChecked: 1 }) }),
    ]);
    expect(flagCell('A')).toHaveTextContent('3 not checked (no age, or no age band)');
    expect(flagCell('A')).not.toHaveTextContent('None');
    expect(flagCell('B')).toHaveTextContent(
      /^1 playing up\s*1 not checked \(no age, or no age band\)$/
    );
  });

  it('reads "Not checked yet" when the divisions were not read, or the row has no counts', () => {
    renderOverview([
      program('Unread', { flags: flags({}, false) }),
      // A caller that has never heard of the counts.
      program('Bare'),
    ]);
    expect(flagCell('Unread').textContent).toBe('Not checked yet');
    expect(flagCell('Bare').textContent).toBe('Not checked yet');
  });

  it('keeps a request with nothing to honour as a note under Players, only when the counts are known', () => {
    renderOverview([
      program('Known', { flags: flags({ askedToPlayUp: 4 }) }),
      program('Unread', { flags: flags({ askedToPlayUp: 4 }, false) }),
      program('Zero', { flags: flags() }),
    ]);
    expect(playersCell('Known')).toHaveTextContent(
      /^24\s*4 asked to play up, registered in their own division$/
    );
    // Not read: whether a request has anything to honour is not known, so nothing is said of it.
    expect(playersCell('Unread').textContent).toBe('24');
    expect(playersCell('Zero').textContent).toBe('24');
    // A request is its own line and never a play-up.
    expect(flagCell('Known').textContent).toBe('None');
  });

  it('puts the request note after the moved notes, on its own line', () => {
    renderOverview([
      program('U12', {
        movedInCount: 6,
        movedOutCount: 1,
        flags: flags({ askedToPlayUp: 2 }),
      }),
    ]);
    expect(playersCell('U12')).toHaveTextContent(
      /^24\s*6 moved here from other divisions\s*1 registered here, placed in their own age division\s*2 asked to play up, registered in their own division$/
    );
  });

  it('has the words of the plan', () => {
    expect(askedToPlayUpNote(4)).toBe('4 asked to play up, registered in their own division');
    expect(movedInFromProgramsNote(2)).toBe('2 moved in from other programs');
    expect(movedInFromProgramsNote(1)).toBe('1 moved in from another program');
    expect(flagLines(flags({ playingUp: 1 })).map((line) => line.text)).toEqual(['1 playing up']);
    expect(flagSummary(flags({ playingUp: 3 }))).toBe('3 playing up, 0 playing down');
    expect(flagSummary(flags({ playingUp: 1, notChecked: 2, askedToPlayUp: 4 }))).toBe(
      '1 playing up, 0 playing down, 2 not checked, 4 asked to play up from their own division'
    );
    expect(flagSummary(flags({}, false))).toBe('not checked yet');
  });

  it('says in a sentence that play-down is not available and that nothing is approved or refused', () => {
    renderOverview([program('U10', { flags: flags() })]);
    const note = document.getElementById('program-overview-note');
    expect(note).toHaveTextContent(
      'Play-down is not available: a player registered in a younger division is placed in their own age division and shown as moved. Play-up is by request. These are flags: nothing here is approved or refused.'
    );
    // The table is described by it, so a screen reader reads it with the table.
    expect(screen.getByRole('table')).toHaveAttribute('aria-describedby', 'program-overview-note');
  });
});

describe('the league line and the program headings', () => {
  const groups = [
    { key: 'p-junior', label: 'Junior', ids: ['U8', 'U10'], flags: flags({ playingUp: 3 }) },
    {
      key: 'p-senior',
      label: 'Senior',
      ids: ['U12'],
      flags: flags({ playingUp: 2, notChecked: 1, movedIn: 2 }),
    },
    { key: 'none', label: 'No program', ids: ['U14'], flags: flags() },
  ];
  const programs = ['U8', 'U10', 'U12', 'U14'].map((id) => program(id, { flags: flags() }));

  it('shows the league’s counts above the table, zero as zero', () => {
    renderOverview(programs, { league: flags({ playingUp: 5 }) });
    expect(screen.getByTestId('play-flags-league').textContent).toBe(
      'League: 5 playing up, 0 playing down.'
    );
  });

  it('says the league is not checked yet rather than zero, before the divisions are read', () => {
    renderOverview(programs, { league: flags({}, false) });
    expect(screen.getByTestId('play-flags-league').textContent).toBe('League: not checked yet.');
  });

  it('puts each program’s counts in its heading, which stays a row group header', () => {
    renderOverview(programs, { groups, league: flags({ playingUp: 5 }) });
    const headings = screen.getAllByRole('rowheader').map((th) => th.textContent);
    expect(headings).toEqual([
      'Junior: 3 playing up, 0 playing down',
      'Senior: 2 playing up, 0 playing down, 1 not checked (2 moved in from other programs)',
      'No program: 0 playing up, 0 playing down',
    ]);
    // The heading spans every column, the new one included.
    const table = screen.getByRole('table');
    const columns = within(table).getAllByRole('columnheader').length;
    expect(columns).toBe(7);
    for (const th of screen.getAllByRole('rowheader')) {
      expect(th).toHaveAttribute('scope', 'rowgroup');
      expect(th).toHaveAttribute('colspan', String(columns));
    }
  });

  it('shows a flat league the league line and no heading', () => {
    renderOverview(programs, { league: flags({ playingUp: 5 }) });
    expect(screen.getByTestId('play-flags-league')).toBeInTheDocument();
    expect(screen.queryAllByRole('rowheader')).toHaveLength(0);
    expect(screen.queryByTestId(/^program-group-/)).toBeNull();
  });

  it('keeps a heading as it was when its group carries no counts', () => {
    renderOverview(programs, {
      groups: groups.map(({ flags: _flags, ...rest }) => rest),
    });
    expect(screen.getAllByRole('rowheader').map((th) => th.textContent)).toEqual([
      'Junior',
      'Senior',
      'No program',
    ]);
    expect(screen.queryByTestId('play-flags-league')).toBeNull();
  });
});
