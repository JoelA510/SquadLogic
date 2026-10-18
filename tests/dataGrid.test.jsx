import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DataGrid from '../frontend/src/components/grid/DataGrid.jsx';

const columns = [
  { key: 'name', label: 'Name', editable: true },
  { key: 'age', label: 'Age', editable: true, type: 'number', num: true },
  {
    key: 'status',
    label: 'Status',
    editable: true,
    type: 'select',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'waitlist', label: 'Waitlist' },
    ],
    optionLabel: (value) => (value === 'waitlist' ? 'Waitlist' : 'Active'),
  },
];

const baseRows = [
  { id: 'r1', name: 'Zoe Park', age: 8, status: 'active' },
  { id: 'r2', name: 'Ben Diaz', age: 7, status: 'waitlist' },
  { id: 'r3', name: 'Ana Cruz', age: 9, status: 'active' },
];

function Harness({ onCellChange = vi.fn(), rows = baseRows, ...props }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  return (
    <DataGrid
      columns={columns}
      rows={rows}
      search={search}
      setSearch={setSearch}
      searchKeys={['name']}
      selected={selected}
      setSelected={setSelected}
      onCellChange={onCellChange}
      {...props}
    />
  );
}

describe('DataGrid', () => {
  it('renders rows with a record count and sorts on header click', () => {
    render(<Harness />);
    expect(screen.getByText('3 records')).toBeInTheDocument();

    const nameHeader = screen.getByText('Name');
    fireEvent.click(nameHeader);
    const cells = screen.getAllByRole('gridcell').map((cell) => cell.textContent);
    expect(cells.join(' ')).toMatch(/Ana Cruz.*Ben Diaz.*Zoe Park/s);
    expect(screen.getByText('Name').closest('th')).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(nameHeader);
    expect(screen.getByText('Name').closest('th')).toHaveAttribute('aria-sort', 'descending');
  });

  // M4.2: the sort lived on a div's onClick, so it could not be reached from the keyboard.
  it('sorts from a header button, which the grid does not take Enter or Space from', () => {
    render(<Harness />);
    const sortName = screen.getByRole('button', { name: 'Name' });
    expect(sortName.closest('th')).not.toBeNull();
    // A native button turns Enter and Space into a click unless something cancels the key.
    // The grid's own key handler used to cancel both (Enter edits a cell, Space selects a row)
    // for every element inside it; fireEvent returns false when the default was prevented.
    expect(fireEvent.keyDown(sortName, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(sortName, { key: ' ' })).toBe(true);
    fireEvent.click(sortName);
    expect(sortName.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    // Control: the same key on an editable cell is still the grid's (it opens the editor).
    expect(fireEvent.keyDown(screen.getByText('Zoe Park').closest('td'), { key: 'Enter' })).toBe(
      false
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Escape' });
    // ...and an arrow pressed on the sort button still moves the grid's active cell.
    expect(fireEvent.keyDown(sortName, { key: 'ArrowDown' })).toBe(false);
  });

  it('renders a non-sortable column header as plain text', () => {
    render(
      <Harness
        columns={[
          { key: 'name', label: 'Name', editable: true, sortable: false },
          ...columns.slice(1),
        ]}
      />
    );
    expect(screen.queryByRole('button', { name: 'Name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Age' })).toBeInTheDocument();
  });

  it('filters rows with instant search', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search table' }), {
      target: { value: 'zoe' },
    });
    expect(screen.getByText('1 record')).toBeInTheDocument();
    expect(screen.queryByText('Ben Diaz')).not.toBeInTheDocument();
  });

  it('edits a text cell on double-click and commits with Enter', () => {
    const onCellChange = vi.fn();
    render(<Harness onCellChange={onCellChange} />);
    fireEvent.doubleClick(screen.getByText('Zoe Park'));
    const input = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: 'Zoe Parker' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCellChange).toHaveBeenCalledWith('r1', 'name', 'Zoe Parker');
    // dirty marker surfaces in the footer
    expect(screen.getByText(/1 edited/)).toBeInTheDocument();
  });

  it('cancels an edit with Escape without committing', () => {
    const onCellChange = vi.fn();
    render(<Harness onCellChange={onCellChange} />);
    fireEvent.doubleClick(screen.getByText('Zoe Park'));
    const input = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCellChange).not.toHaveBeenCalled();
    expect(screen.getByText('Zoe Park')).toBeInTheDocument();
  });

  it('commits select edits from the dropdown editor', () => {
    const onCellChange = vi.fn();
    render(<Harness onCellChange={onCellChange} />);
    const statusCell = screen.getAllByText('Active')[0];
    fireEvent.doubleClick(statusCell);
    const select = screen.getByRole('combobox', { name: 'Status' });
    fireEvent.change(select, { target: { value: 'waitlist' } });
    fireEvent.keyDown(select, { key: 'Enter' });
    expect(onCellChange).toHaveBeenCalledWith('r1', 'status', 'waitlist');
  });

  it('navigates with arrow keys and starts an edit by typing', () => {
    const onCellChange = vi.fn();
    render(<Harness onCellChange={onCellChange} />);
    screen.getByText('Zoe Park').closest('td').focus(); // the first cell
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' }); // row 2
    fireEvent.keyDown(document.activeElement, { key: 'X' });
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveValue('X');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onCellChange).toHaveBeenCalledWith('r2', 'name', 'X');
  });

  it('selects rows and shows the bulk bar with count', () => {
    render(<Harness bulkActions={<button type="button">Mark paid</button>} />);
    const checkboxes = screen.getAllByRole('checkbox', { name: 'Select row' });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark paid' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });

  it('renders the add-row affordance and empty state', () => {
    const onAddRow = vi.fn();
    render(<Harness rows={[]} onAddRow={onAddRow} emptyText="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add row/ }));
    expect(onAddRow).toHaveBeenCalled();
  });

  it('virtualizes long lists (renders a bounded subset of rows)', () => {
    const manyRows = Array.from({ length: 1400 }, (_, index) => ({
      id: `p${index}`,
      name: `Player ${index}`,
      age: 7 + (index % 5),
      status: 'active',
    }));
    render(<Harness rows={manyRows} />);
    expect(screen.getByText('1400 records')).toBeInTheDocument();
    const table = screen.getByRole('grid');
    const renderedRows = within(table).getAllByRole('row');
    // header + virtual window (+ spacers), far fewer than 1400
    expect(renderedRows.length).toBeLessThan(120);
  });
});

/**
 * Plan, Discovered (M4.2): the grid was one `role="application"` widget whose key handler took Tab
 * to move the active cell, so once a cell was active, focus could not leave by keyboard (WCAG
 * 2.1.2). It is now a `role="grid"` with one tab stop (a roving tabindex over its cells, and the
 * one widget a cell holds): arrows move focus within it and Tab is the browser's, out of it.
 */
describe('DataGrid keyboard (role="grid", WCAG 2.1.2)', () => {
  /** Elements Tab can land on: the container itself and everything in it with tabIndex >= 0. */
  const tabStops = (container) =>
    [container, ...container.querySelectorAll('*')].filter(
      (el) => el.tabIndex >= 0 && !el.disabled
    );

  const renderWithNeighbour = (props = {}) =>
    render(
      <>
        <Harness {...props} />
        <button type="button">After the grid</button>
      </>
    );

  it('lets Tab leave once a cell is active, and is a single tab stop', () => {
    renderWithNeighbour();
    const grid = screen.getByLabelText('Data grid');
    tabStops(grid)[0].focus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    // Tab is not the grid's: an unprevented Tab is the browser moving focus to the next stop.
    expect(fireEvent.keyDown(document.activeElement, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true })).toBe(true);
    // ...and the next stop is outside the grid: nothing else inside it is in the tab order.
    expect(tabStops(grid)).toHaveLength(1);
    expect(tabStops(grid)[0]).toBe(document.activeElement);
  });

  it('moves focus between cells, the selection column and the header with the arrow keys', () => {
    renderWithNeighbour();
    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const [stop] = tabStops(grid);
    expect(stop).toHaveTextContent('Zoe Park');
    stop.focus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Ben Diaz');
    expect(document.activeElement).toHaveAttribute('role', 'gridcell');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement).toHaveTextContent('7');
    // A cell holding one widget gives focus to the widget.
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getAllByRole('checkbox', { name: 'Select row' })[1]);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Select all rows' }));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Name' }));
    // The roving stop follows focus.
    expect(tabStops(grid)).toEqual([document.activeElement]);
  });

  it('reaches each widget of a cell that holds several with Left and Right', () => {
    const onEdit = vi.fn();
    renderWithNeighbour({
      selectable: false,
      columns: [
        { key: 'name', label: 'Name' },
        {
          key: 'actions',
          label: 'Actions',
          render: (row) => (
            <>
              <button type="button" onClick={() => onEdit(row.id)}>
                Edit {row.name}
              </button>
              <button type="button">Remove {row.name}</button>
            </>
          ),
        },
        { key: 'age', label: 'Age' },
      ],
    });
    const grid = screen.getByRole('grid', { name: 'Data grid' });
    tabStops(grid)[0].focus();
    expect(document.activeElement).toHaveTextContent('Zoe Park');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit Zoe Park' }));
    // Enter is the button's own (a native button turns it into a click), not an edit.
    expect(fireEvent.keyDown(document.activeElement, { key: 'Enter' })).toBe(true);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Zoe Park' }));
    expect(tabStops(grid)).toEqual([document.activeElement]);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement).toHaveTextContent('8');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit Zoe Park' }));
  });

  it('returns focus to the grid after Enter commits an edit, but not after a blur', () => {
    const onCellChange = vi.fn();
    renderWithNeighbour({ onCellChange });
    const grid = screen.getByRole('grid', { name: 'Data grid' });
    tabStops(grid)[0].focus();
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Zoe Parks' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCellChange).toHaveBeenCalledWith('r1', 'name', 'Zoe Parks');
    expect(document.activeElement).toHaveTextContent('Ben Diaz');

    // An edit left by moving focus elsewhere commits without pulling focus back into the grid.
    fireEvent.keyDown(document.activeElement, { key: 'F2' });
    const after = screen.getByRole('button', { name: 'After the grid' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Ben Diaz Jr' },
    });
    act(() => after.focus());
    expect(onCellChange).toHaveBeenCalledWith('r2', 'name', 'Ben Diaz Jr');
    expect(document.activeElement).toBe(after);
  });

  it('counts the header row in aria-rowcount and indexes each row', () => {
    render(<Harness />);
    const grid = screen.getByRole('grid', { name: 'Data grid' });
    expect(grid).toHaveAttribute('aria-rowcount', '4');
    const rows = within(grid).getAllByRole('row');
    expect(rows.map((row) => row.getAttribute('aria-rowindex'))).toEqual(['1', '2', '3', '4']);
  });
});

/**
 * #591 review (Codex): opening a row's actions menu mounted `role="menuitem"` buttons with their
 * native tab stop, after the grid had last taken its cells' widgets out of the tab order, so the
 * grid had more than one tab stop and Tab from the open cell walked into the menu instead of out.
 * The menu's items are never tab stops (WAI-ARIA APG menu pattern), Tab closes the menu, and the
 * menu's own keys (arrows, Escape) keep working inside the grid.
 */
describe('DataGrid row-actions menu keeps the single tab stop', () => {
  const tabStops = (container) =>
    [container, ...container.querySelectorAll('*')].filter(
      (el) => el.tabIndex >= 0 && !el.disabled
    );

  const renderWithActions = () => {
    const onRowAction = vi.fn();
    render(
      <>
        <Harness
          rowActions={[
            { id: 'open', label: 'Open record' },
            { id: 'delete', label: 'Delete player', danger: true },
          ]}
          onRowAction={onRowAction}
        />
        <button type="button">After the grid</button>
      </>
    );
    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const trigger = screen.getAllByRole('button', { name: 'Row actions' })[0];
    // Reach the trigger the keyboard way: End on the first row lands on the actions cell.
    tabStops(grid)[0].focus();
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    return { grid, trigger, onRowAction };
  };

  it('leaves no menu item in the tab order, so Tab from the open cell leaves the grid', () => {
    const { grid, trigger } = renderWithActions();
    for (const item of screen.getAllByRole('menuitem')) expect(item.tabIndex).toBe(-1);
    expect(tabStops(grid)).toEqual([trigger]);
    // Tab is the browser's (not prevented) and closes the menu on its way out.
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the menu keyboard: arrows move within it, Tab from an item closes it', () => {
    renderWithActions();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open record' }));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete player' }));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open record' }));
    expect(fireEvent.keyDown(document.activeElement, { key: 'Tab' })).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('returns focus to the row-actions cell on Escape, and the grid keys work again', () => {
    const { trigger } = renderWithActions();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open record' }));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // With the menu closed, an arrow on the trigger is the grid's again: down a row.
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Row actions' })[1]);
  });

  it('runs the chosen action from the keyboard', () => {
    const { onRowAction } = renderWithActions();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    fireEvent.click(document.activeElement);
    expect(onRowAction).toHaveBeenCalledWith('open', expect.objectContaining({ id: 'r1' }));
  });
});
