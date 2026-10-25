// The admin's all-teams export as XLSX, and what the master files leave out
// (plan docs/changes/2026-10-22-admin-focus.md, R7). The XLSX is the master
// CSV's own rows and columns (`Coach Emails` included: the Exports page is an
// admin's); an assignment with no time, which the master cannot hold
// (`generateScheduleExports` requires a start and an end), is counted and
// said beside the files rather than left out without a word.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OutputGenerationPanel, {
  untimedAssignmentsNote,
} from '../frontend/src/components/OutputGenerationPanel.jsx';
import { generateScheduleExports } from '@squadlogic/core/outputGeneration.js';
import { readXlsx } from './helpers/readXlsx.js';

const teams = [
  {
    id: 'team-1',
    name: '007 Bears',
    division: 'U10',
    coachName: 'Alex Coach',
    coachEmail: 'alex@example.com',
  },
  { id: 'team-2', name: 'Red Foxes', division: 'U10' },
];
const practiceAssignments = [
  {
    teamId: 'team-1',
    start: '2026-04-06T17:30:00Z',
    end: '2026-04-06T18:30:00Z',
    fieldId: 'Field 1',
    slotId: 's1',
  },
];
const gameAssignments = [
  {
    homeTeamId: 'team-1',
    awayTeamId: 'team-2',
    start: '2026-04-11T16:00:00Z',
    end: '2026-04-11T17:00:00Z',
    fieldId: 'Field 2',
  },
  // A run row with no kickoff: not in the master files, and said.
  { homeTeamId: 'team-2', awayTeamId: 'team-1', start: null, end: null, fieldId: 'Field 2' },
];

let saved;
beforeEach(() => {
  saved = [];
  let current = null;
  URL.createObjectURL = vi.fn((blob) => {
    current = blob;
    return 'blob:export';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    saved.push({ name: this.download, blob: current });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('the master schedule as XLSX', () => {
  it('downloads the master CSV’s rows and columns as text cells', async () => {
    render(
      <OutputGenerationPanel
        teams={teams}
        practiceAssignments={practiceAssignments}
        gameAssignments={gameAssignments}
        supabaseClient={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download Master XLSX' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe('master-schedule.xlsx');

    // The oracle: the core export of the same placed rows.
    const { master } = generateScheduleExports({
      teams: teams.map((t) => ({ ...t })),
      practiceAssignments,
      gameAssignments: gameAssignments.slice(0, 1),
    });
    const sheet = readXlsx(new Uint8Array(await saved[0].blob.arrayBuffer()));
    expect(sheet.rows[0]).toEqual(master.headers);
    expect(sheet.rows.slice(1)).toEqual(
      master.rows.map((row) => master.headers.map((h) => String(row[h] ?? '')))
    );
    expect(sheet.rows.slice(1).some((row) => row.includes('007 Bears'))).toBe(true);
    // The CSV's row count: a practice, and the game from both sides.
    expect(sheet.rows).toHaveLength(1 + 3);
  });

  it('says what the master files leave out', async () => {
    render(
      <OutputGenerationPanel
        teams={teams}
        practiceAssignments={practiceAssignments}
        gameAssignments={gameAssignments}
        supabaseClient={null}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    expect(
      await screen.findByText(
        /1 game assignment\(s\) with no start or end time are not in these files/
      )
    ).toBeInTheDocument();
  });

  it('words the note for each source, and says nothing when nothing is left out', () => {
    expect(untimedAssignmentsNote({ games: 0, practices: 0 })).toBeNull();
    expect(untimedAssignmentsNote({ games: 2, practices: 1 })).toMatch(
      /^2 game assignment\(s\) and 1 practice assignment\(s\) with no start or end time/
    );
    expect(untimedAssignmentsNote({ games: 0, practices: 3 })).toMatch(
      /^3 practice assignment\(s\) with no start or end time/
    );
  });
});
