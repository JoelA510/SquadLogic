/**
 * 8.8 PR 2 -- ConsequencePreview's `reassign` arm.
 *
 * The coaching consequence is rendered through the existing component rather
 * than a new one. What this pins: the coverage rows come from the report, a
 * missing report reads "could not be computed" rather than blank, an empty
 * change list reads as an answer, and the bookings half -- which nothing here
 * computes -- is stated as not computed instead of rendered as "nothing booked".
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { repairProposal } from '@squadlogic/core/fieldAdmin/index.js';
import ConsequencePreview from '../frontend/src/components/scheduling/ConsequencePreview.jsx';

const base = {
  subject: 'Team A',
  operation: 'reassign',
  repair: repairProposal(),
  titleId: 'preview-title',
};

describe('ConsequencePreview -- reassign', () => {
  it('lists the teams whose cover moves, with who a sole-coach team now depends on', () => {
    render(
      <ConsequencePreview
        {...base}
        coverage={{
          effectiveOn: '2026-09-23',
          teamsExamined: 3,
          changes: [
            {
              teamId: 't1',
              teamName: 'Team A',
              effect: 'sole',
              stateBefore: 'covered',
              soleCoachName: 'Coach C',
            },
            {
              teamId: 't2',
              teamName: 'Team B',
              effect: 'uncoached',
              stateBefore: 'sole',
              soleCoachName: null,
            },
          ],
        }}
      />
    );
    expect(screen.getByTestId('coverage-examined')).toHaveTextContent('3');
    expect(screen.getByTestId('coverage-row-sole')).toHaveTextContent('only Coach C');
    expect(screen.getByTestId('coverage-row-uncoached')).toHaveTextContent('has no coach');
    expect(screen.getByTestId('coverage-bookings-not-computed')).toBeInTheDocument();
    // The bookings arm is absent, not rendered with a zero.
    expect(screen.queryByTestId('consequence-none')).toBeNull();
    expect(screen.getByTestId('repair-proposal-unavailable')).toBeInTheDocument();
  });

  it('labels an empty change list as an answer', () => {
    render(
      <ConsequencePreview
        {...base}
        coverage={{ effectiveOn: '2026-09-23', teamsExamined: 4, changes: [] }}
      />
    );
    expect(screen.getByTestId('coverage-none')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-rows')).toBeNull();
  });

  it('says "could not be computed" when there is no report, never a blank panel', () => {
    render(<ConsequencePreview {...base} />);
    expect(screen.getByTestId('coverage-not-computed')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-none')).toBeNull();
  });
});
