import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import GameReadinessPanel from '../frontend/src/components/GameReadinessPanel.jsx';

it('renders saved pair IDs, a missing directory team and historical text on the same review', () => {
  const entries = [
    { weekIndex: 1, matchup: { homeTeamId: 'team-1', awayTeamId: 'team-2' } },
    { weekIndex: 2, matchup: { homeTeamId: 'team-3', awayTeamId: 'team-1' } },
    { weekIndex: 3, matchup: 'Earlier home vs Earlier away' },
  ].map((entry) => ({ ...entry, reason: 'no-slot-available' }));
  render(
    <GameReadinessPanel
      gameReadinessSnapshot={{ unscheduled: entries }}
      gameSummary={{ unscheduledMatchups: 3, scheduledRate: 0, teamsWithByes: 0 }}
      generatedAt="2026-11-27T18:00:00Z"
      teamNames={
        new Map([
          ['team-1', 'North Lions'],
          ['team-2', 'South Wolves'],
        ])
      }
    />
  );
  const list = within(screen.getByRole('article', { name: 'Unscheduled matchups' }));
  expect(list.getByText('North Lions vs South Wolves')).toBeVisible();
  expect(list.getByText('team-3 vs North Lions')).toBeVisible();
  expect(list.getByText('Earlier home vs Earlier away')).toBeVisible();
  expect(list.getAllByText('no-slot-available')).toHaveLength(3);
});
