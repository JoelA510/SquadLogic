// @vitest-environment jsdom
//
// Every probable-move team can be ticked on its own (Codex C6 on #732), however many there are. The steps of the
// Practices tab are rendered with a dry run's result of 202 teams with a probable move each, in the shape
// `apply_practice_import_job` returns (migration 20261123010000; `arriving` rows with `probable_move` and `added`). A
// season the practice run filled with that many teams is reachable: on a first import every team whose saved
// practices meet the file's dates is one. What the tab sends is read from the mapping it asks to store.
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { default: PracticeImportSteps } =
  await import('../frontend/src/components/import/PracticeImportSteps.jsx');

const N = 202;
const name = (i) => `T-${String(i).padStart(3, '0')}`;
const preview = {
  counts: { rows: N, placements: N, held_back: N, arriving: N, probable_move_teams: N },
  arriving: Array.from({ length: N }, (_, k) => ({
    row: k + 1,
    row_key: `row-${k + 1}`,
    team_id: `team-${k + 1}`,
    team: name(k + 1),
    probable_move: true,
    added: false,
  })),
  leaving: [],
  refused: [],
  skipped: [],
  flagged: [],
  flags: {},
  holds: [],
  time_tbd: { teams: [] },
  coverage: { checked: [], not_checked: [] },
};

function Harness({ onPreview }) {
  const [practice, setPractice] = useState({
    dates: { validFrom: '', validUntil: '' },
    aliasFile: null,
    previous: null,
    settingsTicks: {},
    moveTicks: [],
  });
  return (
    <PracticeImportSteps
      step="preview"
      fileName="practices.csv"
      staging={{}}
      rows={[]}
      league={{ divisions: [], teams: [], locations: [], fields: [], subunits: [] }}
      choices={{}}
      setChoices={() => {}}
      practice={practice}
      setPractice={setPractice}
      sent={{ creations: {}, mapping: { options: { add_moved_rows: [] } }, settings: [] }}
      preview={preview}
      stale={null}
      counts={preview.counts}
      createAck={false}
      setCreateAck={() => {}}
      result={null}
      settingsOutcome={null}
      busy={null}
      unknown={false}
      rolledBackHere={false}
      undone={null}
      jobId="job"
      onPreview={onPreview}
      onConfirm={() => {}}
      onBack={() => {}}
      onCancel={() => {}}
      onRollback={() => {}}
      onReset={() => {}}
      onDone={undefined}
      describeRolledBack={() => ''}
    />
  );
}

describe('202 teams with a probable move', () => {
  it('says how many are shown, shows every one on request, and sends only the one team ticked', () => {
    const onPreview = vi.fn();
    render(<Harness onPreview={onPreview} />);
    expect(screen.getByTestId('practice-import-moves-count').textContent).toBe(
      '0 teams of 202 ticked. Showing the first 25 of 202 teams.'
    );
    expect(screen.queryByLabelText("Add T-201's 1 new row")).toBeNull();
    const more = screen.getByRole('button', { name: 'Show all 202 teams' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(screen.getByRole('button', { name: 'Show only the first 25 teams' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    fireEvent.click(screen.getByLabelText("Add T-201's 1 new row"));
    expect(screen.getByLabelText("Add T-201's 1 new row")).toBeChecked();
    expect(screen.getByLabelText("Add T-202's 1 new row")).not.toBeChecked();
    expect(screen.getByTestId('practice-import-moves-count').textContent).toMatch(
      /^1 team of 202 ticked\. Showing all 202 teams\.$/
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update the preview with these ticks' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview.mock.calls[0][0].options.add_moved_rows).toEqual(['row-201']);
  });
});
