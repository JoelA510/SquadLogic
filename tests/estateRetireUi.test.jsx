/**
 * The venue and sub-surface halves of 8.4 gap B, exercised rather than asserted.
 *
 * **Every check here is enumerated from the FIXTURE, never from the DOM it is
 * checking.** The Phase 2 review found a flagship coverage check deriving its
 * universe from the same filter the rule applied -- it compared a set against
 * itself. So the containment assertions below walk `CONTAINED_NODES`, the
 * constant the RPC stand-in returns, and demand that each one be found: a node
 * dropped by the renderer is a missing row, not an absent expectation.
 *
 * **Positive controls are in the file, not in a comment.** Where a property
 * could be satisfied by a component that does the wrong thing, the wrong thing
 * is constructed and the assertion is shown to reject it.
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { repairProposal } from '@squadlogic/core/fieldAdmin/index.js';
import ConsequencePreview from '../frontend/src/components/scheduling/ConsequencePreview.jsx';
import RetireEstateNodeDialog from '../frontend/src/components/setup/RetireEstateNodeDialog.jsx';

const VENUE = { id: 'loc-1', name: 'Maplewood Park' };

/**
 * What `estate_contained_nodes` reports for that venue.
 *
 * Three nodes, one of which already ends before the date being applied, so
 * `contained_count` (which counts only the still-live ones) is 2 and NOT 3.
 * A component that rendered `contained.length` where the count belongs would
 * pass a test whose fixture had no already-retired node in it.
 */
const CONTAINED_NODES = [
  {
    kind: 'field',
    id: 'f-1',
    name: 'North Pitch',
    own_effective_to: null,
    already_retired: false,
  },
  {
    kind: 'field',
    id: 'f-2',
    name: 'South Pitch',
    own_effective_to: '2026-08-01',
    already_retired: true,
  },
  {
    kind: 'field_subunit',
    id: 'su-1',
    name: 'North Pitch A',
    own_effective_to: null,
    already_retired: false,
  },
];

const VENUE_REFUSAL = {
  retired: false,
  reason: 'bookings_after_effective_to',
  affected_count: 1,
  affected: [
    {
      kind: 'game_slot',
      id: 'gs-9',
      on_date: '2026-10-10',
      undated: false,
      unbounded: false,
      field_id: 'f-1',
    },
  ],
  contained_count: 2,
  contained: CONTAINED_NODES,
};

const VENUE_COMMITTED = {
  retired: true,
  affected_count: 0,
  affected: [],
  contained_count: 2,
  contained: CONTAINED_NODES,
  location: { id: 'loc-1', effective_to: '2026-09-30' },
};

/** @param {object} overrides */
function renderPreview(overrides = {}) {
  return render(
    <ConsequencePreview
      subject={VENUE.name}
      operation="retire"
      affectedCount={VENUE_REFUSAL.affected_count}
      rows={VENUE_REFUSAL.affected}
      repair={repairProposal({ affectedCount: VENUE_REFUSAL.affected_count })}
      titleId="t"
      {...overrides}
    />
  );
}

describe('ConsequencePreview: the containment half of a venue retirement', () => {
  it('renders every contained node, enumerated from the estate and not from the table', () => {
    renderPreview({ contained: CONTAINED_NODES, containedCount: 2 });

    const table = screen.getByTestId('contained-rows');
    // **The meta-assertion.** A fixture that contained nothing would make every
    // loop below vacuous, so the universe is asserted to be non-empty first and
    // the row count is pinned to the estate's size.
    expect(CONTAINED_NODES.length).toBeGreaterThan(0);
    expect(within(table).getAllByRole('row')).toHaveLength(CONTAINED_NODES.length + 1);

    for (const node of CONTAINED_NODES) {
      const cell = within(table).queryByText(node.name);
      expect(cell, `contained node ${node.name} is missing from the table`).not.toBeNull();
      const row = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (cell).closest('tr'));
      // Its own end date is reported from the node's own window, so a child
      // already closed by an earlier decision is not claimed as newly affected.
      expect(row).toHaveTextContent(node.own_effective_to ?? 'none');
      expect(
        within(row).getByText(
          node.already_retired ? /already ends by then/i : /closes with the venue/i
        )
      ).toBeInTheDocument();
      expect(row).toHaveTextContent(node.kind === 'field_subunit' ? 'sub-surface' : 'field');
    }
  });

  it('is a table of GROUND, not a second booking list', () => {
    renderPreview({ contained: CONTAINED_NODES, containedCount: 2 });

    // The two tables are distinct elements with distinct captions...
    const bookings = screen.getByTestId('consequence-rows');
    const ground = screen.getByTestId('contained-rows');
    expect(bookings).not.toBe(ground);
    expect(ground).toHaveTextContent(/Fields and sub-surfaces contained by/i);

    // ...and no contained node has leaked into the booking table. **This is the
    // failure the brief names first**: rendering containment as though it were
    // bookings.
    //
    // **The first version of this check was hollow and a plant proved it.** It
    // looked for each contained node's NAME inside the booking table -- but the
    // booking table renders `kind` and a date and has no name column, so a
    // component that appended every contained node to the booking list passed
    // it. The evidence a leak actually leaves is a row COUNT that no longer
    // matches the bookings the RPC sent, and a row whose kind is a piece of
    // ground rather than a booking. Both are enumerated from `VENUE_REFUSAL`,
    // the data a leak does not corrupt.
    const bookingRows = within(bookings).getAllByRole('row').slice(1);
    expect(VENUE_REFUSAL.affected.length).toBeGreaterThan(0);
    expect(bookingRows).toHaveLength(VENUE_REFUSAL.affected.length);
    const bookingKinds = new Set(VENUE_REFUSAL.affected.map((row) => row.kind.replace(/_/g, ' ')));
    for (const row of bookingRows) {
      const kind = /** @type {HTMLElement} */ (row.querySelector('td')).textContent;
      expect(bookingKinds.has(/** @type {string} */ (kind))).toBe(true);
    }

    // Real column headers, not styled divs.
    const headers = within(ground)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(['Kind', 'Name', 'Its own end date', 'Effect']);
  });

  it('counts the still-live nodes, not the contained ones', () => {
    renderPreview({ contained: CONTAINED_NODES, containedCount: 2 });
    // The estate holds three; two of them close with the venue.
    expect(screen.getByTestId('contained-total')).toHaveTextContent('3');
    expect(screen.getByTestId('contained-live')).toHaveTextContent('2');
    expect(screen.queryByTestId('contained-count-disagrees')).toBeNull();

    // **Positive control for the disagreement guard.** A count that does not
    // match the rows the RPC sent must be reported, not silently preferred.
    const { unmount } = render(
      <ConsequencePreview
        subject={VENUE.name}
        operation="retire"
        affectedCount={0}
        rows={[]}
        repair={repairProposal({ affectedCount: 0 })}
        contained={CONTAINED_NODES}
        containedCount={99}
      />
    );
    expect(screen.getByTestId('contained-count-disagrees')).toHaveTextContent('99');
    unmount();
  });

  it('says a venue holds nothing, and says nothing at all where the RPC reports no containment', () => {
    // `[]` -- the venue was read and holds nothing. An operator who believes
    // there are four pitches here needs that sentence.
    const { unmount } = renderPreview({ contained: [], containedCount: 0 });
    expect(screen.getByTestId('consequence-contained')).toBeInTheDocument();
    expect(screen.getByTestId('contained-none')).toHaveTextContent(/Nothing sits at this venue/i);
    expect(screen.queryByTestId('contained-rows')).toBeNull();
    unmount();

    // `undefined` -- `admin_retire_field_subunit` ships no `contained` key at
    // all, because a sub-surface is the leaf of the estate. "Nothing below" and
    // "nobody looked" must not render identically.
    renderPreview({ contained: undefined, containedCount: undefined });
    expect(screen.queryByTestId('consequence-contained')).toBeNull();
    expect(screen.queryByTestId('contained-none')).toBeNull();
  });

  it('still names the repair as unavailable on the containment path', () => {
    renderPreview({ contained: CONTAINED_NODES, containedCount: 2 });
    // Reused, not reinvented: 8.6 does not exist at any depth.
    expect(screen.getByTestId('repair-proposal-unavailable')).toHaveAttribute(
      'data-reason-code',
      'REPAIR_PROPOSAL_UNAVAILABLE'
    );
  });
});

/** A host that owns the open state, so focus return has somewhere to return to. */
function Host({ kind, node, onRetire, onRetired = undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open {node.name}
      </button>
      {open && (
        <RetireEstateNodeDialog
          open
          node={node}
          kind={kind}
          defaultDate="2026-09-30"
          onRetire={onRetire}
          onRetired={onRetired}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe('RetireEstateNodeDialog at venue and sub-surface depth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels the control for the depth it is retiring', async () => {
    render(<Host kind="location" node={VENUE} onRetire={vi.fn()} />);
    fireEvent.click(screen.getByText('Open Maplewood Park'));
    // Found through the accessibility tree: a label whose `htmlFor` does not
    // reach the input fails to find the element rather than passing a lint rule.
    const date = await screen.findByLabelText(/Last day this venue is usable/);
    expect(date).toHaveAttribute('type', 'date');
    expect(screen.getByText(/closes with it, by containment/i)).toBeInTheDocument();
  });

  it('shows the containment beside the bookings on a refusal, then commits on confirmation', async () => {
    const onRetire = vi
      .fn()
      .mockResolvedValueOnce(VENUE_REFUSAL)
      .mockResolvedValueOnce({ ...VENUE_COMMITTED, contained: undefined });

    render(<Host kind="location" node={VENUE} onRetire={onRetire} />);
    fireEvent.click(screen.getByText('Open Maplewood Park'));
    fireEvent.click(screen.getByText('Check and retire'));

    await waitFor(() => expect(screen.getByTestId('consequence-preview')).toBeInTheDocument());
    // The first call is unconfirmed: the dry run IS the guard's own reading.
    expect(onRetire).toHaveBeenNthCalledWith(1, 'loc-1', {
      effectiveTo: '2026-09-30',
      confirm: false,
    });
    // Both halves are on screen.
    expect(screen.getByTestId('consequence-rows')).toBeInTheDocument();
    expect(screen.getByTestId('contained-rows')).toBeInTheDocument();
    for (const node of CONTAINED_NODES) {
      expect(screen.getByText(node.name)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByText('Retire anyway'));
    await waitFor(() =>
      expect(onRetire).toHaveBeenNthCalledWith(2, 'loc-1', {
        effectiveTo: '2026-09-30',
        confirm: true,
      })
    );
  });

  it('refuses a quiet venue on its containment alone, then commits on confirmation', async () => {
    const onRetired = vi.fn();
    // **Nothing is booked, and the retirement still refuses.** Until
    // 20260912000000 the venue arm gated on the bookings half alone, so this
    // committed on the first call and the containment report reached nobody.
    // The refusal now names the other half by its own reason.
    const QUIET_REFUSAL = {
      retired: false,
      reason: 'contained_estate_after_effective_to',
      affected_count: 0,
      affected: [],
      contained_count: 2,
      contained: CONTAINED_NODES,
    };
    const onRetire = vi
      .fn()
      .mockResolvedValueOnce(QUIET_REFUSAL)
      .mockResolvedValueOnce({ ...VENUE_COMMITTED });

    render(<Host kind="location" node={VENUE} onRetire={onRetire} onRetired={onRetired} />);
    fireEvent.click(screen.getByText('Open Maplewood Park'));
    fireEvent.click(screen.getByText('Check and retire'));

    // The bookings half is empty and says so; the containment half is the
    // reason the operator is being asked.
    await waitFor(() => expect(screen.getByTestId('consequence-none')).toBeInTheDocument());
    expect(screen.getByTestId('contained-rows')).toBeInTheDocument();
    for (const node of CONTAINED_NODES) {
      expect(screen.getByText(node.name)).toBeInTheDocument();
    }
    expect(onRetired).not.toHaveBeenCalled();

    // **One path, not two.** The containment arrives through the same refusal
    // the bookings already used, so confirming is the same button.
    fireEvent.click(screen.getByText('Retire anyway'));
    await waitFor(() =>
      expect(onRetire).toHaveBeenNthCalledWith(2, 'loc-1', {
        effectiveTo: '2026-09-30',
        confirm: true,
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onRetired).toHaveBeenCalledTimes(1);
  });

  it('commits on the first call when the estate has nothing live left to close', async () => {
    // The empty case: no bookings and no still-live contained node, so the RPC
    // commits unconfirmed and there is nothing to confirm. `admin_delete_field`
    // behaves the same way with nothing to take.
    const onRetire = vi.fn().mockResolvedValue({
      retired: true,
      affected_count: 0,
      affected: [],
      contained_count: 0,
      contained: [],
      location: { id: 'loc-1', effective_to: '2026-09-30' },
    });
    render(<Host kind="location" node={VENUE} onRetire={onRetire} />);
    fireEvent.click(screen.getByText('Open Maplewood Park'));
    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it('closes straight through at sub-surface depth, where there is no containment to show', async () => {
    const SUBUNIT = { id: 'su-1', name: 'North Pitch A' };
    // `admin_retire_field_subunit` returns NO `contained` key.
    const onRetire = vi.fn().mockResolvedValue({
      retired: true,
      affected_count: 0,
      affected: [],
      field_subunit: { id: 'su-1', effective_to: '2026-09-30' },
    });

    render(<Host kind="field_subunit" node={SUBUNIT} onRetire={onRetire} />);
    fireEvent.click(screen.getByText('Open North Pitch A'));
    expect(await screen.findByLabelText(/Last day this sub-surface is usable/)).toBeInTheDocument();
    // No containment sentence at a depth that contains nothing.
    expect(screen.queryByText(/closes with it, by containment/i)).toBeNull();

    fireEvent.click(screen.getByText('Check and retire'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByTestId('consequence-contained')).toBeNull();
  });

  it('returns focus to the control that opened it, at venue depth too', async () => {
    render(<Host kind="location" node={VENUE} onRetire={vi.fn()} />);
    const trigger = screen.getByText('Open Maplewood Park');
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it('refuses an unknown depth rather than falling back to the field arm', () => {
    // A default would render a venue retirement with no containment section and
    // no sentence saying so -- the same silence `isFieldOfferableOn` refuses a
    // default for.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <RetireEstateNodeDialog
          open
          // @ts-expect-error [TEST] - the point of the test is the bad kind.
          kind="pitch"
          node={VENUE}
          defaultDate="2026-09-30"
          onRetire={vi.fn()}
          onClose={vi.fn()}
        />
      )
    ).toThrow(/unknown estate kind/i);
    spy.mockRestore();
  });
});
