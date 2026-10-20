/**
 * The teaming settings panel recommends a team count for the program and warns, before
 * generation, when the chosen count would leave teams over the maximum or under the minimum
 * roster (`assessTeamCount`, packages/core/src/rosterSizing.js). The generator computed these
 * diagnostics but nothing showed them.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TeamingConfiguration from '../frontend/src/components/teaming/TeamingConfiguration.jsx';

const program = { id: 'u10-boys', name: 'U10 Boys', playerCount: 30, estimatedTeams: 3 };
const limits = { targetTeamSize: 12, minRosterSize: 10, maxRosterSize: 14 };

function renderPanel(config, onUpdate = vi.fn()) {
  render(<TeamingConfiguration program={program} config={config} onUpdate={onUpdate} />);
  return onUpdate;
}

describe('TeamingConfiguration team-count advice', () => {
  it('shows the recommendation and no warning when the count fits', () => {
    renderPanel({ ...limits, teamCountOverride: 3 });
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 3 teams for 30 players'
    );
    expect(screen.queryByTestId('team-count-warnings')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use 3' })).toBeNull();
  });

  it('warns in a live region when the override leaves teams short, and offers the fix', () => {
    const onUpdate = renderPanel({ ...limits, teamCountOverride: 4 });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(
      'With 4 teams, some teams would have only 7 players, under the minimum of 10.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use 3' }));
    expect(onUpdate).toHaveBeenCalledWith('u10-boys', { teamCountOverride: 3 });
  });

  it('judges the estimate when there is no override', () => {
    render(
      <TeamingConfiguration
        program={{ ...program, estimatedTeams: 2 }}
        config={{ ...limits, teamCountOverride: null }}
        onUpdate={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'With 2 teams, some teams would have 15 players, over the maximum of 14. Use at least 3 teams.'
    );
  });
});
