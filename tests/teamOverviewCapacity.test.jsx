import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mapSchedulerRunToSummary } from '@squadlogic/core/utils/teamSummaryMapper.js';
import TeamOverviewPanel from '../frontend/src/components/TeamOverviewPanel.jsx';
import TeamListView from '../frontend/src/components/teaming/TeamListView.jsx';

function savedRun(totalPlayers, totalCapacity) {
  return mapSchedulerRunToSummary({
    created_at: '2026-01-02T17:00:00Z',
    results: {
      teamsByDivision: { Junior: [{ id: 'a' }, { id: 'b' }] },
      rosterBalanceByDivision: { Junior: { summary: { totalPlayers, totalCapacity } } },
    },
  });
}

describe.each([
  ['graphical overview', TeamOverviewPanel],
  ['accessible table', TeamListView],
])('%s', (_name, Panel) => {
  it.each([
    [25, 28, '89%'],
    [0, 28, '0%'],
    [29, 28, '104%'],
    [3, undefined, 'Capacity unavailable'],
  ])('shows %s assigned against a saved capacity of %s', (assigned, capacity, expected) => {
    render(<Panel {...savedRun(assigned, capacity)} />);
    if (Panel === TeamListView) {
      const row = screen.getByRole('row', { name: /^Junior / });
      expect(within(row).getAllByRole('cell')[3]).toHaveTextContent(expected);
    } else {
      const division = screen.getByRole('article', { name: 'Junior' });
      expect(within(division).getByText(expected)).toBeVisible();
    }
    if (Panel === TeamOverviewPanel && capacity === undefined) {
      expect(screen.getByRole('article', { name: 'Target Players' })).toHaveTextContent(
        'Unavailable'
      );
    }
  });
});
