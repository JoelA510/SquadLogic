/**
 * The three surfaces 8.4 PR 3 adds, and the accessibility properties they
 * claim.
 *
 * **Accessibility is exercised here, not asserted.** `getByLabelText` resolves
 * through the accessibility tree, so a label whose `htmlFor` does not reach its
 * control fails to find the element rather than passing a lint rule; Escape,
 * Tab and focus return are driven as events and read back off
 * `document.activeElement`. Every one of those has a positive control below or
 * in the plant log: the property has to be makeable-to-fail to be worth
 * stating.
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { repairProposal } from '@squadlogic/core/fieldAdmin/index.js';
import ConsequencePreview from '../frontend/src/components/scheduling/ConsequencePreview.jsx';
import RetireFieldDialog from '../frontend/src/components/setup/RetireFieldDialog.jsx';
import BlackoutEditor from '../frontend/src/components/setup/BlackoutEditor.jsx';

const FIELD = { id: 'field-1', name: 'North Field' };

const RETIRE_REFUSAL = {
  retired: false,
  reason: 'bookings_after_effective_to',
  affected_count: 2,
  affected: [
    { kind: 'game_slot', id: 'gs-1', on_date: '2026-10-03', undated: false, unbounded: false },
    { kind: 'practice_slot', id: 'ps-1', on_date: null, undated: false, unbounded: true },
  ],
};

const DELETE_REFUSAL_ROWS = [
  { kind: 'game', id: 'g-1', on_date: '2026-10-03', disposition: 'deleted' },
  { kind: 'game_assignment', id: 'ga-1', on_date: '2026-10-03', disposition: 'unassigned' },
];

describe('ConsequencePreview', () => {
  it('names an empty result rather than rendering nothing', () => {
    render(
      <ConsequencePreview
        subject="North Field"
        operation="retire"
        affectedCount={0}
        rows={[]}
        repair={repairProposal()}
      />
    );
    // **"Nothing is booked" and "we did not look" render identically as white
    // space.** One of them has to be words.
    expect(screen.getByTestId('consequence-none')).toHaveTextContent(/not an empty panel/i);
    expect(screen.queryByTestId('consequence-rows')).not.toBeInTheDocument();
  });

  it('renders the delete arm with its per-row outcome', () => {
    render(
      <ConsequencePreview
        subject="North Field"
        operation="delete"
        affectedCount={2}
        rows={DELETE_REFUSAL_ROWS}
        repair={repairProposal({ affectedCount: 2 })}
      />
    );
    const table = screen.getByTestId('consequence-rows');
    expect(within(table).getByText('destroyed with the field')).toBeInTheDocument();
    expect(within(table).getByText('survives, without a venue')).toBeInTheDocument();
    // A real table with a caption and column headers, so a screen reader can
    // navigate it — not a stack of divs.
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
  });

  it('omits the outcome column on the retirement arm, and says why', () => {
    render(
      <ConsequencePreview
        subject="North Field"
        operation="retire"
        affectedCount={2}
        rows={RETIRE_REFUSAL.affected}
        repair={repairProposal({ affectedCount: 2 })}
      />
    );
    const table = screen.getByTestId('consequence-rows');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
    expect(within(table).queryByText(/destroyed with the field/)).not.toBeInTheDocument();
    expect(screen.getByTestId('consequence-retire-note')).toHaveTextContent(/removes nothing/i);
    // The two readings a row can carry that are not a date.
    expect(within(table).getByText('runs indefinitely')).toBeInTheDocument();
  });

  it('never asserts a survival the database did not promise', () => {
    // **Review finding.** `hasDisposition` is `some(...)` while the cell was a
    // binary, so a row with no disposition -- or one carrying a word this
    // component does not know -- rendered as "survives, without a venue". That
    // is the failure this component's own docblock says it exists to avoid,
    // one `else` further in.
    render(
      <ConsequencePreview
        subject="North Field"
        operation="delete"
        affectedCount={3}
        rows={[
          ...DELETE_REFUSAL_ROWS,
          { kind: 'practice_assignment', id: 'pa-1', on_date: '2026-10-03' },
        ]}
        repair={repairProposal({ affectedCount: 3 })}
      />
    );
    const table = screen.getByTestId('consequence-rows');
    expect(within(table).getByText('outcome not stated')).toBeInTheDocument();
    // The anchor: the two words it DOES know still render, so this is a third
    // arm rather than a blanket change.
    expect(within(table).getByText('destroyed with the field')).toBeInTheDocument();
    expect(within(table).getByText('survives, without a venue')).toBeInTheDocument();
  });

  it('states the sample when the RPC counted more than it listed', () => {
    render(
      <ConsequencePreview
        subject="North Field"
        operation="delete"
        affectedCount={97}
        rows={DELETE_REFUSAL_ROWS}
        repair={repairProposal({ affectedCount: 97 })}
      />
    );
    expect(screen.getByTestId('consequence-sampled')).toHaveTextContent('Showing 2 of 97');
  });

  it('names the missing repair engine on both paths', () => {
    for (const affectedCount of [0, 2]) {
      const { unmount } = render(
        <ConsequencePreview
          subject="North Field"
          operation="delete"
          affectedCount={affectedCount}
          rows={affectedCount === 0 ? [] : DELETE_REFUSAL_ROWS}
          repair={repairProposal({ affectedCount })}
        />
      );
      const panel = screen.getByTestId('repair-proposal-unavailable');
      expect(panel).toHaveAttribute('data-reason-code', 'REPAIR_PROPOSAL_UNAVAILABLE');
      expect(panel).toHaveTextContent(/not a statement that no repair is needed/i);
      unmount();
    }
  });
});

/** A host that owns the open state, so focus return has somewhere to return to. */
function RetireHost({ onRetire }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Retire North Field
      </button>
      {open && (
        <RetireFieldDialog
          open
          field={FIELD}
          defaultDate="2026-09-30"
          onRetire={onRetire}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe('RetireFieldDialog', () => {
  it('refuses first, shows what stands, then retires on confirmation', async () => {
    const onRetire = vi
      .fn()
      .mockResolvedValueOnce(RETIRE_REFUSAL)
      .mockResolvedValueOnce({ retired: true, affected_count: 2, field: { id: 'field-1' } });

    render(<RetireHost onRetire={onRetire} />);
    fireEvent.click(screen.getByText('Retire North Field'));

    // The date is found through its LABEL, which only works if `htmlFor`
    // reaches the input.
    const date = screen.getByLabelText(/Last day this ground is usable/);
    expect(date).toHaveAttribute('type', 'date');

    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() => expect(screen.getByTestId('consequence-preview')).toBeInTheDocument());

    // **The first call is unconfirmed.** The guard lives in the RPC, so the
    // preview has to be obtained by asking it, not by assembling a second
    // reading in the browser.
    expect(onRetire).toHaveBeenNthCalledWith(1, 'field-1', {
      effectiveTo: '2026-09-30',
      confirm: false,
    });
    expect(screen.getByTestId('consequence-preview')).toHaveTextContent('2');

    fireEvent.click(screen.getByText('Retire anyway'));
    await waitFor(() =>
      expect(onRetire).toHaveBeenNthCalledWith(2, 'field-1', {
        effectiveTo: '2026-09-30',
        confirm: true,
      })
    );
    // It closed, so the operator is not left looking at a stale preview.
    await waitFor(() =>
      expect(screen.queryByTestId('consequence-preview')).not.toBeInTheDocument()
    );
  });

  it('retires straight through when nothing is booked', async () => {
    const onRetire = vi.fn().mockResolvedValue({ retired: true, affected_count: 0 });
    render(<RetireHost onRetire={onRetire} />);
    fireEvent.click(screen.getByText('Retire North Field'));
    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it('drops a stale preview when the date changes', async () => {
    const onRetire = vi.fn().mockResolvedValue(RETIRE_REFUSAL);
    render(<RetireHost onRetire={onRetire} />);
    fireEvent.click(screen.getByText('Retire North Field'));
    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() => expect(screen.getByTestId('consequence-preview')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Last day this ground is usable/), {
      target: { value: '2026-11-30' },
    });
    // **A new date is a new question.** Confirming against a list computed for
    // a different date is confirming against a list that was never computed.
    expect(screen.queryByTestId('consequence-preview')).not.toBeInTheDocument();
    expect(screen.getByText('Check and retire')).toBeInTheDocument();
  });

  it('surfaces a thrown error rather than closing silently', async () => {
    const onRetire = vi.fn().mockRejectedValue(new Error('no readable result'));
    render(<RetireHost onRetire={onRetire} />);
    fireEvent.click(screen.getByText('Retire North Field'));
    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no readable result'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('is escapable and returns focus to the control that opened it', async () => {
    render(<RetireHost onRetire={vi.fn()} />);
    const trigger = screen.getByText('Retire North Field');
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus moved into the dialog rather than staying behind it.
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });
});

const LOCATIONS = [{ id: 'loc-1', name: 'Riverside Park' }];
const FIELDS = [{ id: 'field-1', name: 'North Field', location_id: 'loc-1' }];
const DATED = [
  {
    kind: 'game',
    id: 'gs-1',
    fieldId: 'field-1',
    label: 'U12 game',
    onDate: '2026-09-16',
    startMinutes: 960,
    endMinutes: 1020,
  },
];
const RECURRING = [
  {
    kind: 'practice',
    id: 'ps-1',
    fieldId: 'field-1',
    label: 'U12 practice',
    dayOfWeek: 3,
    startMinutes: 960,
    endMinutes: 1020,
    validFrom: '2026-08-01',
    validUntil: '2026-11-30',
  },
];

function renderEditor(overrides = {}) {
  const onCreate = overrides.onCreate ?? vi.fn().mockResolvedValue({ id: 'bo-1' });
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <BlackoutEditor
      open
      onClose={onClose}
      onCreate={onCreate}
      locations={LOCATIONS}
      fields={FIELDS}
      dated={DATED}
      recurring={RECURRING}
      defaultDate="2026-09-16"
    />
  );
  return { onCreate, onClose };
}

describe('BlackoutEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('labels every control, and each one is reachable through its label', () => {
    renderEditor();
    // Each of these resolves through the accessibility tree; an unbound label
    // throws here rather than passing.
    expect(screen.getByLabelText('What does this close?')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Field/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^First day/)).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText(/^Last day/)).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText(/Closed all day/)).toHaveAttribute('type', 'checkbox');
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
    expect(screen.getByLabelText('Note')).toBeInTheDocument();
  });

  it('reveals keyboard-operable time inputs when the all-day switch is turned off', () => {
    renderEditor();
    expect(screen.queryByLabelText(/^Closed from/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Closed all day/));
    expect(screen.getByLabelText(/^Closed from/)).toHaveAttribute('type', 'time');
    expect(screen.getByLabelText(/^Closed until/)).toHaveAttribute('type', 'time');
  });

  it('previews what the draft would close, before anything is written', () => {
    const { onCreate } = renderEditor();
    fireEvent.change(screen.getByLabelText(/^Field/), { target: { value: 'field-1' } });
    const panel = screen.getByTestId('blackout-consequence');
    // One game on the 16th and one Wednesday practice inside the window.
    expect(panel).toHaveTextContent('would close 2 existing bookings');
    expect(panel).toHaveTextContent('U12 game');
    expect(panel).toHaveTextContent('U12 practice');
    // Preview only: nothing was written to get it.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('says when nothing was available to check, rather than showing a bare zero', () => {
    render(
      <BlackoutEditor
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        locations={LOCATIONS}
        fields={FIELDS}
        dated={[]}
        recurring={[]}
        defaultDate="2026-09-16"
      />
    );
    fireEvent.change(screen.getByLabelText(/^Field/), { target: { value: 'field-1' } });
    expect(screen.getByTestId('blackout-nothing-compared')).toHaveTextContent(
      /not the same as nothing being booked/i
    );
  });

  it('refuses an invalid draft with a message beside the reason, not a constraint name', async () => {
    const { onCreate } = renderEditor();
    fireEvent.change(screen.getByLabelText(/^Field/), { target: { value: 'field-1' } });
    fireEvent.change(screen.getByLabelText(/^Last day/), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByText('Save blackout'));

    await waitFor(() =>
      expect(screen.getByTestId('blackout-issues')).toHaveTextContent(/must not fall before/i)
    );
    // The positive control for "before it is written": the RPC was never called.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('submits the scope on exactly one side, with times when they are given', async () => {
    const { onCreate } = renderEditor();
    fireEvent.change(screen.getByLabelText('What does this close?'), {
      target: { value: 'location' },
    });
    fireEvent.change(screen.getByLabelText(/^Venue/), { target: { value: 'loc-1' } });
    fireEvent.click(screen.getByLabelText(/Closed all day/));
    fireEvent.change(screen.getByLabelText(/^Closed from/), { target: { value: '16:00' } });
    fireEvent.change(screen.getByLabelText(/^Closed until/), { target: { value: '19:30' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'weather' } });
    fireEvent.click(screen.getByText('Save blackout'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({
      scope: 'location',
      scopeId: 'loc-1',
      blackoutFrom: '2026-09-16',
      blackoutUntil: '2026-09-16',
      allDay: false,
      startMinutes: 960,
      endMinutes: 1170,
      reason: 'weather',
      note: null,
    });
  });

  it('refuses a note shaped like personal data, and accepts ordinary prose', async () => {
    // The guard is `NoteSchema` in the domain layer, reached through
    // `BlackoutDraftSchema`. This case exists to prove the FORM routes through
    // it: the first draft of the hook declared `z.string().max(200)` here, a
    // second and weaker producer of the same verdict, and this test is what
    // found it.
    const { onCreate } = renderEditor();
    fireEvent.change(screen.getByLabelText(/^Field/), { target: { value: 'field-1' } });
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'ask groundskeeper@club.test to reopen' },
    });
    fireEvent.click(screen.getByText('Save blackout'));
    await waitFor(() =>
      expect(screen.getByTestId('blackout-issues')).toHaveTextContent(/email-shaped/i)
    );
    expect(onCreate).not.toHaveBeenCalled();

    // **The other arm.** A guard that refused everything would pass the
    // assertion above and be useless; ordinary operator prose has to get
    // through. `findIdentityShapes` is asked for `allowCommonAbbreviations`
    // precisely so "6 p.m." is not read as an initialism.
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'reseeding; closed after 6 p.m.' },
    });
    fireEvent.click(screen.getByText('Save blackout'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0][0].note).toBe('reseeding; closed after 6 p.m.');
  });

  it('states its source rather than asking for one the table cannot hold', () => {
    renderEditor();
    expect(screen.getByTestId('blackout-source')).toHaveTextContent(/entered here by an admin/i);
    // A `source` input would be a field parsed and never read: the table has no
    // such column.
    expect(screen.queryByLabelText(/^Source/)).not.toBeInTheDocument();
  });

  it('reports a failed write instead of closing as though it worked', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('Access denied'));
    const onClose = vi.fn();
    renderEditor({ onCreate, onClose });
    fireEvent.change(screen.getByLabelText(/^Field/), { target: { value: 'field-1' } });
    fireEvent.click(screen.getByText('Save blackout'));
    await waitFor(() =>
      expect(screen.getByTestId('blackout-issues')).toHaveTextContent('Access denied')
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

/** The window the edit cases open on: timed, field-scoped, with a note. */
const EDITING = {
  id: 'bo-1',
  source: 'field_blackouts',
  closesFieldId: 'field-1',
  closesLocationId: null,
  blackoutFrom: '2026-09-16',
  blackoutUntil: '2026-09-18',
  startMinutes: 960,
  endMinutes: 1170,
  reason: 'weather',
  note: 'storm damage',
};

function renderEdit(overrides = {}) {
  const onUpdate = overrides.onUpdate ?? vi.fn().mockResolvedValue({ id: 'bo-1' });
  const onCreate = overrides.onCreate ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <BlackoutEditor
      open
      onClose={onClose}
      onCreate={onCreate}
      onUpdate={onUpdate}
      editing={overrides.editing ?? EDITING}
      locations={LOCATIONS}
      fields={FIELDS}
      dated={DATED}
      recurring={RECURRING}
      defaultDate="2026-09-16"
    />
  );
  return { onCreate, onUpdate, onClose };
}

describe('BlackoutEditor :: editing an existing window', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens on the window it was given, times and all', () => {
    renderEdit();
    expect(screen.getByLabelText(/^First day/)).toHaveValue('2026-09-16');
    expect(screen.getByLabelText(/^Last day/)).toHaveValue('2026-09-18');
    // A timed window opens with the all-day switch OFF and both boxes filled --
    // an editor that opened every window as all-day would silently offer to
    // clear the times.
    expect(screen.getByLabelText(/Closed all day/)).not.toBeChecked();
    expect(screen.getByLabelText(/^Closed from/)).toHaveValue('16:00');
    expect(screen.getByLabelText(/^Closed until/)).toHaveValue('19:30');
    expect(screen.getByLabelText('Reason')).toHaveValue('weather');
    expect(screen.getByLabelText('Note')).toHaveValue('storm damage');
  });

  it('keeps every accessibility property the add path has', () => {
    renderEdit();
    // Focus moves INTO the dialog on open, on this path as much as the other.
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Labels still bind, so every control is reachable through the tree.
    expect(screen.getByLabelText('What does this close?')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Field/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
    // The locked scope is DISABLED with an explanation bound by
    // `aria-describedby`, not silently read-only: a control a screen reader
    // announces as ordinary and that refuses input is worse than one announced
    // as unavailable.
    const scope = screen.getByLabelText('What does this close?');
    expect(scope).toBeDisabled();
    expect(scope.getAttribute('aria-describedby')).toBe('blackout-scope-help');
    expect(document.getElementById('blackout-scope-help')).toHaveTextContent(/cannot be changed/i);
    // The live region survives, and the preview is inside it.
    fireEvent.change(screen.getByLabelText(/^Last day/), { target: { value: '2026-09-16' } });
    const preview = screen.getByTestId('blackout-consequence');
    expect(preview.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('previews the consequence of the EDIT, exactly as the add path does', () => {
    const { onUpdate } = renderEdit();
    // Widen the window to all day over the 16th: the seeded game is inside it.
    fireEvent.click(screen.getByLabelText(/Closed all day/));
    const panel = screen.getByTestId('blackout-consequence');
    expect(panel).toHaveTextContent(/As edited, this window would close/);
    expect(panel).toHaveTextContent('U12 game');
    // Preview only: nothing was written to get it.
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('submits the whole editable shape through onUpdate, and never through onCreate', async () => {
    const { onCreate, onUpdate } = renderEdit();
    fireEvent.click(screen.getByLabelText(/Closed all day/));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    // **Every editable column, including the ones now NULL.** A form that sent
    // only what changed could not express "all day" or "no note".
    expect(onUpdate).toHaveBeenCalledWith({
      scope: 'field',
      scopeId: 'field-1',
      blackoutFrom: '2026-09-16',
      blackoutUntil: '2026-09-18',
      allDay: true,
      startMinutes: null,
      endMinutes: null,
      reason: 'maintenance',
      note: null,
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('opens a location-scoped window on the venue select, not the field one', () => {
    renderEdit({
      editing: {
        ...EDITING,
        closesFieldId: null,
        closesLocationId: 'loc-1',
        startMinutes: null,
        endMinutes: null,
      },
    });
    // The scope is derived from which column the closure fills. Reading the
    // wrong one would open a venue closure as a field closure and the hook's
    // move guard would then refuse a save the operator never asked to change.
    expect(screen.getByLabelText('What does this close?')).toHaveValue('location');
    expect(screen.getByLabelText(/^Venue/)).toHaveValue('loc-1');
  });

  it('reports a failed edit instead of closing as though it worked', async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('Access denied'));
    const onClose = vi.fn();
    renderEdit({ onUpdate, onClose });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() =>
      expect(screen.getByTestId('blackout-issues')).toHaveTextContent('Access denied')
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
