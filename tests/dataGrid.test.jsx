import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
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
    // Control: the same keys on the grid itself are still the grid's.
    expect(fireEvent.keyDown(screen.getByRole('application'), { key: 'Enter' })).toBe(false);
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
    const app = screen.getByRole('application');
    fireEvent.keyDown(app, { key: 'ArrowDown' }); // activate first cell
    fireEvent.keyDown(app, { key: 'ArrowDown' }); // row 2
    fireEvent.keyDown(app, { key: 'X' });
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
    const table = screen.getByRole('table');
    const renderedRows = within(table).getAllByRole('row');
    // header + virtual window (+ spacers), far fewer than 1400
    expect(renderedRows.length).toBeLessThan(120);
  });
});
