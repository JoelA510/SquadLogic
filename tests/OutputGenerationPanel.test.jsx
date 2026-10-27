import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OutputGenerationPanel from '../frontend/src/components/OutputGenerationPanel.jsx';
import { generateScheduleExports } from '@squadlogic/core/outputGeneration.js';
import { teamsWithCoachSourceDisagreement } from '@squadlogic/core/people/coachList.js';
import { teamCoaches } from '../frontend/src/utils/teamCoaches.js';

const teams = [
  {
    id: 'team-1',
    name: 'Blue Bears',
    division: 'U10',
    coachId: 'coach-1',
    coachName: 'Alex Coach',
    coachEmail: 'alex@example.com',
    // 8.2: a co-coach with an address of their own gets their own draft; one
    // with none is counted and reported rather than silently skipped.
    assistantCoachIds: ['coach-2', 'coach-3'],
    assistantCoaches: ['Robin Coach', 'Sam Coach'],
    assistantCoachEmails: ['robin@example.com', ''],
  },
];

const practiceAssignments = [
  {
    teamId: 'team-1',
    start: '2026-04-06T17:30:00Z',
    end: '2026-04-06T18:30:00Z',
    day: 'Monday',
    fieldId: 'Field 1',
    slotId: 'practice_17:30',
    notes: 'Half field',
  },
];

describe('OutputGenerationPanel', () => {
  it('generates CSV output and uses explicit button controls', async () => {
    render(
      <OutputGenerationPanel
        teams={teams}
        practiceAssignments={practiceAssignments}
        supabaseClient={null}
      />
    );

    const generateButton = screen.getByRole('button', { name: 'Generate CSVs' });
    expect(generateButton).toHaveAttribute('type', 'button');

    fireEvent.click(generateButton);

    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled();
    expect(screen.getByText('Generating CSVs...')).toBeInTheDocument();
    expect(await screen.findByText('Generated Files')).toBeInTheDocument();
    expect(screen.getByText('Master Schedule: 1 rows')).toBeInTheDocument();
    expect(screen.getByText('Team Schedules: 1 files')).toBeInTheDocument();
    expect(screen.getByText('CSVs generated successfully.')).toBeInTheDocument();

    const upload = screen.getByRole('button', { name: 'Upload to Storage' });
    expect(upload).toHaveAttribute('type', 'button');
    // The theme's primary button: white on `bg-orange-500` was 2.88:1 (axe `color-contrast`).
    expect(upload).toHaveClass('btn', 'btn-primary');
    expect(upload.className).not.toMatch(/orange/);
    expect(screen.getByRole('button', { name: 'Download Master CSV' })).toHaveAttribute(
      'type',
      'button'
    );
  });

  it('reports a team whose two sources disagree about who is first', async () => {
    // The message existed and could not fire: the panel reconciled each row
    // itself, passed the settled list to the export, and the export then saw
    // one source. Both sources now reach the core, whose findings the panel
    // reads. Slot 1 here is `c1` by the `coaches` list and `c2` by `coachId`.
    const disagreeing = [
      {
        id: 'team-2',
        name: 'Red Foxes',
        division: 'U10',
        coachId: 'c2',
        coaches: [
          { personId: 'c1', displayName: 'Casey', slot: 1 },
          { personId: 'c2', displayName: 'Drew', slot: 2 },
        ],
      },
    ];
    // POSITIVE CONTROL, the wrong implementation constructed: the row
    // collapsed to its settled list first hands the core one source, and the
    // disagreement is gone before the message could read it.
    const collapsed = generateScheduleExports({
      teams: [{ id: 'team-2', coaches: teamCoaches(disagreeing[0]) }],
      practiceAssignments: [{ ...practiceAssignments[0], teamId: 'team-2' }],
    });
    expect(teamsWithCoachSourceDisagreement(collapsed.coachFindings)).toEqual([]);

    render(
      <OutputGenerationPanel
        teams={disagreeing}
        practiceAssignments={[{ ...practiceAssignments[0], teamId: 'team-2' }]}
        supabaseClient={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    expect(
      await screen.findByText(
        /1 team\(s\) have sources that disagree about their coaches; every coach is exported/
      )
    ).toBeInTheDocument();
    // …and the single-source team above renders the plain success line, so
    // the message is a fact about the sources and not about every export.
    expect(screen.queryByText('CSVs generated successfully.')).toBeNull();
  });

  it('reports a coach no row carries an id for, rather than a clean sheet', async () => {
    const nameOnly = [
      { id: 'team-3', name: 'Green Owls', division: 'U10', coachName: 'Coach Mike' },
    ];
    render(
      <OutputGenerationPanel
        teams={nameOnly}
        practiceAssignments={[{ ...practiceAssignments[0], teamId: 'team-3' }]}
        supabaseClient={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    expect(
      await screen.findByText(/1 team\(s\) have a coach with no id on file; they are exported/)
    ).toBeInTheDocument();
    // It is not reported as a disagreement: one source, one reading.
    expect(screen.queryByText(/sources that disagree/)).toBeNull();
  });

  it('generates coach email drafts from the available team schedule', () => {
    render(
      <OutputGenerationPanel
        teams={teams}
        practiceAssignments={practiceAssignments}
        supabaseClient={null}
      />
    );

    const emailButton = screen.getByRole('button', { name: 'Generate Draft Welcome Emails' });
    expect(emailButton).toHaveAttribute('type', 'button');

    fireEvent.click(emailButton);

    expect(
      screen.getByText(
        'Generated 2 email drafts, one per coach. 1 coach(es) have no name or address on file and were not written to.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/To: Alex Coach <alex@example\.com>/)).toBeInTheDocument();
    // The co-coach who used to get nothing.
    expect(screen.getByText(/To: Robin Coach <robin@example\.com>/)).toBeInTheDocument();
    // …and the one with no address is named in the count, not dropped in silence.
    expect(screen.queryByText(/To: Sam Coach/)).toBeNull();
    expect(screen.getAllByText(/Your assigned practice schedule is:/).length).toBe(2);
  });
});

// The demo's Exports page produced files with only the header row: the master and per-team
// files hold one row per practice or game, and a league that has applied no schedule has none
// (migration 20261030010000's `start_demo_session` seeds teams, players and coaches, and no
// `practice_assignments` or game run). The page now says so instead of downloading headers.
describe('OutputGenerationPanel with nothing scheduled', () => {
  const press = async (control) => {
    fireEvent.click(control);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('says what is missing and writes no file', async () => {
    render(<OutputGenerationPanel teams={teams} supabaseClient={null} />);

    const generate = screen.getByRole('button', { name: 'Generate CSVs' });
    const reason = screen.getByTestId('csv-empty-reason');
    expect(reason).toHaveTextContent('no practices or games have been applied');
    expect(reason).toHaveTextContent('Practices');
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    expect(generate.getAttribute('aria-describedby')).toBe(reason.getAttribute('id'));

    await press(generate);
    expect(screen.queryByText('Generated Files')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Master CSV' })).toBeNull();
  });

  it('POSITIVE CONTROL: one applied practice is a real export and no empty notice', async () => {
    render(
      <OutputGenerationPanel
        teams={teams}
        practiceAssignments={practiceAssignments}
        supabaseClient={null}
      />
    );
    expect(screen.queryByTestId('csv-empty-reason')).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate CSVs' })).not.toHaveAttribute(
      'aria-disabled'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    expect(await screen.findByText('Master Schedule: 1 rows')).toBeInTheDocument();
  });

  it('refuses a file of headers when every applied practice has no time', async () => {
    render(
      <OutputGenerationPanel
        teams={teams}
        practiceAssignments={[{ teamId: 'team-1', day: 'Monday', slotId: 'practice_17:30' }]}
        supabaseClient={null}
      />
    );
    await press(screen.getByRole('button', { name: 'Generate CSVs' }));
    await waitFor(() =>
      expect(screen.getByTestId('output-generation-status')).toHaveTextContent(
        'with no start or end time are not in these files'
      )
    );
    expect(screen.queryByText('Generated Files')).toBeNull();
  });
});
