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
  render(
    <TeamingConfiguration program={program} config={config} onUpdate={onUpdate} onSave={vi.fn()} />
  );
  return onUpdate;
}

describe('TeamingConfiguration team-count advice', () => {
  it('shows the recommendation and no warning when the count fits', () => {
    renderPanel({ ...limits, teamCountOverride: 3 });
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 3 teams for 30 players.'
    );
    expect(screen.queryByTestId('team-count-warnings')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use 3' })).toBeNull();
  });

  it('says in a live region that generation will not use the override, and offers the fix', () => {
    const onUpdate = renderPanel({ ...limits, teamCountOverride: 4 });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Generation will make 3 teams, not the 4 set here'
    );
    const use = screen.getByRole('button', { name: 'Use 3' });
    use.focus();
    fireEvent.click(use);
    expect(onUpdate).toHaveBeenCalledWith('u10-boys', { teamCountOverride: 3 });
    // The button disappears once applied; focus goes to the field it changed.
    expect(document.activeElement).toBe(screen.getByLabelText('Override Team Count'));
  });

  it('warns when the max-teams cap forces oversized teams, and never offers a count past the cap', () => {
    renderPanel({ ...limits, teamCountOverride: 2, maxTeams: 2 });
    expect(screen.getByRole('status')).toHaveTextContent(
      'With 2 teams, some teams will have 15 players, over the maximum of 14. The maximum of 2 teams prevents more.'
    );
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it('stays quiet when the page already rejects the configuration', () => {
    renderPanel({ ...limits, minRosterSize: 14, maxRosterSize: 10 });
    expect(screen.queryByTestId('team-count-recommendation')).toBeNull();
    expect(screen.queryByTestId('team-count-warnings')).toBeNull();
  });
});
