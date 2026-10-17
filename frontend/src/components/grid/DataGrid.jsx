import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import Dropdown from '../ui/Dropdown.jsx';
import Button from '../ui/Button.jsx';
import GridCell from './GridCell.jsx';
import GridCheckbox from './GridCheckbox.jsx';
import { useGridSelection } from './useGridSelection.js';
import { allFocusables, cellWidgets, focusTargetOf, useGridKeyboard } from './useGridKeyboard.js';

const ROW_HEIGHT = 38;
const DENSE_ROW_HEIGHT = 32;
// Virtualization only kicks in past this row count; small tables render
// plainly so unit tests and short lists keep natural semantics.
const VIRTUALIZE_THRESHOLD = 60;

/**
 * Excel-grade editable data grid (Lightning-class).
 *
 * Column spec: { key, label, width?, editable?, type?: 'text'|'number'|'select',
 * options?, optionLabel?, render?, sortVal?, num?, center?, sticky?,
 * sortable?, placeholder?, onClickCell?, min?, max? }.
 *
 * Interaction: click cell → active; type/Enter/F2/dblclick → edit;
 * Enter commits+down, Tab commits+right, Esc cancels; Space toggles row
 * selection; header click sorts; instant search over `searchKeys`.
 * Rows are virtualized via @tanstack/react-virtual beyond ~60 rows.
 *
 * Keyboard: a `role="grid"` with one tab stop (a roving tabindex over its
 * cells, or the one widget a cell holds), so Tab enters and leaves it and the
 * arrow keys move within it, the header row and the selection column included
 * (useGridKeyboard). Only an open editor takes Tab, to commit and move right.
 */
export default function DataGrid({
  columns,
  rows,
  getRowId = (row) => row.id,
  onCellChange = undefined,
  onAddRow = undefined,
  onRowAction = undefined,
  rowActions = [],
  selectable = true,
  selected = undefined,
  setSelected = undefined,
  search = '',
  setSearch = undefined,
  searchKeys = undefined,
  toolbar = null,
  toolbarRight = null,
  bulkActions = null,
  onRowClick = undefined,
  emptyText = 'No records',
  addLabel = 'Add row',
  dense = false,
  label = 'Data grid',
}) {
  const [sort, setSort] = useState({ key: null, dir: 1 });
  // { r, c } over the rendered cells: r is -1 for the header row; c counts the selection column
  // (when there is one), the data columns, then the row-actions column (useGridKeyboard).
  const [active, setActive] = useState(null);
  const [editing, setEditing] = useState(null); // { r, c } into view/columns (data columns only)
  const [editVal, setEditVal] = useState('');
  const [dirty, setDirty] = useState(() => new Set()); // "rowId:key"
  const gridRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  // Set when a key, or the end of an edit, moves the active cell: the next render focuses it.
  const pendingFocusRef = useRef(false);
  // The element in the active cell that last had focus (one of several widgets, say).
  const lastFocusedRef = useRef(null);
  const colOffset = selectable ? 1 : 0;
  const colCount = colOffset + columns.length + (rowActions.length > 0 ? 1 : 0);
  const requestFocus = () => {
    pendingFocusRef.current = true;
  };

  // ---- derived rows: search + sort ----
  const view = useMemo(() => {
    let v = rows;
    if (search && searchKeys) {
      const q = search.toLowerCase();
      v = v.filter((row) =>
        searchKeys.some((key) =>
          String(row[key] ?? '')
            .toLowerCase()
            .includes(q)
        )
      );
    }
    if (sort.key) {
      const col = columns.find((c) => c.key === sort.key);
      v = [...v].sort((a, b) => {
        let av = col?.sortVal ? col.sortVal(a) : a[sort.key];
        let bv = col?.sortVal ? col.sortVal(b) : b[sort.key];
        if (av == null) av = '';
        if (bv == null) bv = '';
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sort.dir;
      });
    }
    return v;
  }, [rows, search, searchKeys, sort, columns]);

  const { localSel, allSel, someSel, toggleAll, toggleRow } = useGridSelection({
    view,
    getRowId,
    selected,
    setSelected,
  });

  const toggleSort = (key) => {
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  };

  // ---- editing ----
  const startEdit = (r, c, initial) => {
    const col = columns[c];
    if (!col?.editable) return;
    const row = view[r];
    setEditing({ r, c });
    setActive({ r, c: c + colOffset });
    setEditVal(initial != null ? initial : String(row[col.key] ?? ''));
  };

  /** The next editable data column from `c`, stepping by `dc`; `c` itself when there is none. */
  const nextEditableCol = (c, dc) => {
    for (let nc = c + dc; nc >= 0 && nc < columns.length; nc += dc) {
      if (columns[nc].editable) return nc;
    }
    return c;
  };

  // `refocus` is false for a commit on blur: focus has gone where the user sent it, which may be
  // outside the grid, and pulling it back would undo that.
  const commitEdit = (move = null, refocus = move !== null) => {
    // Side effects stay OUTSIDE state updaters: updaters must be pure
    // (StrictMode double-invokes them, which would fire onCellChange — and
    // its audited RPC — twice per commit).
    if (editing) {
      const col = columns[editing.c];
      const row = view[editing.r];
      /** @type {any} */
      let value = editVal;
      if (col.type === 'number') {
        value = value === '' ? null : Number(value);
        if (Number.isNaN(value)) value = row[col.key];
        if (value != null && col.min != null) value = Math.max(col.min, Number(value));
        if (value != null && col.max != null) value = Math.min(col.max, Number(value));
      }
      if (value !== row[col.key] && onCellChange) {
        onCellChange(getRowId(row), col.key, value);
        setDirty((d) => new Set(d).add(`${getRowId(row)}:${col.key}`));
      }
      setEditing(null);
      if (move) {
        const r = Math.min(view.length - 1, Math.max(0, editing.r + move.dr));
        const c = move.dc ? nextEditableCol(editing.c, move.dc) : editing.c;
        setActive({ r, c: c + colOffset });
        if (virtualize) rowVirtualizer.scrollToIndex(r);
      }
    }
    if (refocus) requestFocus();
  };

  const cancelEdit = () => {
    setEditing(null);
    requestFocus();
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current.select && columns[editing.c].type !== 'select') {
        inputRef.current.select();
      }
    }
  }, [editing, columns]);

  // ---- virtualization ----
  const rowHeight = dense ? DENSE_ROW_HEIGHT : ROW_HEIGHT;
  const virtualize = view.length > VIRTUALIZE_THRESHOLD;
  const rowVirtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    enabled: virtualize,
  });

  const keyboard = useGridKeyboard({
    view,
    columns,
    colOffset,
    colCount,
    setActive,
    editing,
    startEdit,
    selectable,
    toggleRow,
    getRowId,
    requestFocus,
    onActiveMove: (next) => {
      if (virtualize) rowVirtualizer.scrollToIndex(next.r);
    },
  });

  // The cell that holds the grid's one tab stop: the active cell, kept inside the rows in view,
  // or before any is active the first editable cell (the header when there are no rows).
  const firstEditable = Math.max(
    0,
    columns.findIndex((col) => col.editable)
  );
  const stopPos = (() => {
    const base = active || { r: 0, c: colOffset + firstEditable };
    return { r: Math.min(view.length - 1, base.r), c: Math.min(colCount - 1, base.c) };
  })();

  // Roving tabindex. Cell contents come from each column's `render`, so the widgets in them are
  // taken out of the tab order here, on the DOM, after every render: every cell and every widget
  // in one gets tabindex -1, then the stop's focus target gets 0. A key or the end of an edit that
  // moved the active cell focuses it now that it is rendered (a virtualized row may not be yet).
  useLayoutEffect(() => {
    const table = gridRef.current;
    if (!table) return;
    const cells = /** @type {HTMLElement[]} */ (
      Array.from(table.querySelectorAll('[data-grid-cell]'))
    );
    if (cells.length === 0) return;
    for (const cell of cells) {
      cell.tabIndex = -1;
      for (const el of allFocusables(cell)) el.tabIndex = -1;
    }
    const stopCell =
      cells.find(
        (cell) => cell.dataset.r === String(stopPos.r) && cell.dataset.c === String(stopPos.c)
      ) || null;
    // A stop scrolled out of a virtualized window still needs a tab stop: the first rendered row.
    const cell = stopCell || cells.find((el) => el.dataset.r !== '-1') || cells[0];
    const last = lastFocusedRef.current;
    const target =
      last instanceof HTMLElement && last !== cell && cellWidgets(cell).includes(last)
        ? last
        : focusTargetOf(cell);
    target.tabIndex = 0;
    // Only from inside the grid (or from nowhere, when an editor just closed): focus the user has
    // since moved elsewhere is never pulled back.
    const focusNow = document.activeElement;
    if (
      pendingFocusRef.current &&
      focusNow &&
      focusNow !== document.body &&
      !table.contains(focusNow)
    ) {
      pendingFocusRef.current = false;
    }
    if (pendingFocusRef.current && stopCell && !editing) {
      pendingFocusRef.current = false;
      target.focus();
    }
  });

  // Focus and the active cell move together, whether focus came by key, pointer or Tab.
  const onGridFocus = (event) => {
    const cell = event.target instanceof Element ? event.target.closest('[data-grid-cell]') : null;
    if (!(cell instanceof HTMLElement)) return;
    // An item of a menu open in the cell is not a stop: the menu unmounts on close, and a stop
    // recorded on its item would leave the grid with none. The trigger stays the cell's stop.
    if (event.target.closest('[role="menu"]')) return;
    lastFocusedRef.current = event.target;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    setActive((current) => (current && current.r === r && current.c === c ? current : { r, c }));
  };

  /** The data attributes that make an element one of the grid's cells (see useGridKeyboard). */
  const cellAttrs = (r, c) => ({
    role: r < 0 ? 'columnheader' : 'gridcell',
    'data-grid-cell': '',
    'data-r': r,
    'data-c': c,
  });

  const onEditKey = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit({ dr: 1, dc: 0 });
    } else if (event.key === 'Tab') {
      event.preventDefault();
      commitEdit({ dr: 0, dc: event.shiftKey ? -1 : 1 });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  };

  const renderRow = (row, r) => {
    const id = getRowId(row);
    const isSel = localSel.has(id);
    return (
      <tr
        key={id}
        className={isSel ? 'sel' : ''}
        aria-selected={selectable ? isSel : undefined}
        aria-rowindex={r + 2}
      >
        {selectable && (
          <td className="col-check" {...cellAttrs(r, 0)}>
            <GridCheckbox checked={isSel} onChange={() => toggleRow(id)} label="Select row" />
          </td>
        )}
        {columns.map((col, c) => (
          <GridCell
            key={col.key}
            row={row}
            col={col}
            cellProps={cellAttrs(r, c + colOffset)}
            isActive={!!active && active.r === r && active.c === c + colOffset}
            isEditing={!!editing && editing.r === r && editing.c === c}
            isDirty={dirty.has(`${id}:${col.key}`)}
            editVal={editVal}
            setEditVal={setEditVal}
            inputRef={inputRef}
            onEditKey={onEditKey}
            onCommit={commitEdit}
            stickyLeft={col.sticky ? (selectable ? 40 : 0) : undefined}
            onMouseDown={(event) => {
              if (!(editing && editing.r === r && editing.c === c)) {
                setActive({ r, c: c + colOffset });
                // A press on a widget in the cell focuses that widget itself.
                const onWidget =
                  event.target instanceof Element &&
                  event.target !== event.currentTarget &&
                  event.target.closest('a[href], button, input, select, textarea, [tabindex]') !==
                    event.currentTarget;
                if (!onWidget) requestFocus();
              }
            }}
            onClick={() => {
              if (col.onClickCell) col.onClickCell(row);
              else if (onRowClick && !col.editable) onRowClick(row);
            }}
            onDoubleClick={() => col.editable && startEdit(r, c)}
          />
        ))}
        {rowActions.length > 0 && (
          <td {...cellAttrs(r, colCount - 1)}>
            <div className="row-actions">
              <Dropdown
                items={rowActions.map((action) => ({
                  id: action.id,
                  label: action.label,
                  icon: action.icon,
                  danger: action.danger,
                  onSelect: () => onRowAction?.(action.id, row),
                }))}
                renderTrigger={({ toggle, triggerProps }) => (
                  <button
                    type="button"
                    className="row-act"
                    title="Row actions"
                    aria-label="Row actions"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle();
                    }}
                    {...triggerProps}
                  >
                    <MoreHorizontal size={16} aria-hidden="true" />
                  </button>
                )}
              />
            </div>
          </td>
        )}
      </tr>
    );
  };

  const totalCols = columns.length + (selectable ? 1 : 0) + (rowActions.length ? 1 : 0);
  const virtualItems = virtualize ? rowVirtualizer.getVirtualItems() : null;
  const padTop = virtualItems?.length ? virtualItems[0].start : 0;
  const padBottom = virtualItems?.length
    ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0;

  return (
    <div className="grid-wrap">
      <div className="grid-toolbar">
        {setSearch && (
          <div className="grid-search">
            <Search size={15} className="muted" aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search…"
              aria-label="Search table"
            />
            {search && (
              <button
                type="button"
                className="row-act"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => setSearch('')}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {toolbar}
        <div className="gt-spacer" />
        {toolbarRight}
      </div>

      {selectable && someSel && (
        <div className="grid-selbar">
          <GridCheckbox
            checked={allSel}
            mixed={!allSel && someSel}
            onChange={toggleAll}
            label="Select all rows"
          />
          <span>{localSel.size} selected</span>
          <div style={{ flex: 1 }} />
          {bulkActions}
          <Button variant="ghost" size="sm" icon={X} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="grid-scroll" ref={scrollRef}>
        <div>
          {/* A composite widget whose focus lives on its cells: each cell, or the one widget it
              holds, is focusable, and exactly one is in the tab order (the layout effect above). */}
          <table
            ref={gridRef}
            className="grid"
            role="grid"
            aria-label={label}
            aria-multiselectable={selectable || undefined}
            aria-rowcount={view.length + 1}
            onKeyDown={keyboard.onKeyDown}
            onFocus={onGridFocus}
            style={dense ? /** @type {any} */ ({ '--row-h': `${DENSE_ROW_HEIGHT}px` }) : undefined}
          >
            <thead>
              <tr aria-rowindex={1}>
                {selectable && (
                  <th className="col-check" {...cellAttrs(-1, 0)}>
                    <GridCheckbox
                      checked={allSel}
                      mixed={!allSel && someSel}
                      onChange={toggleAll}
                      label="Select all rows"
                    />
                  </th>
                )}
                {columns.map((col, c) => (
                  <th
                    key={col.key}
                    {...cellAttrs(-1, c + colOffset)}
                    className={`${col.num ? 'num' : ''} ${col.sticky ? 'sticky-col' : ''}`.trim()}
                    style={{
                      width: col.width,
                      minWidth: col.width,
                      left: col.sticky ? (selectable ? 40 : 0) : undefined,
                    }}
                    aria-sort={
                      sort.key === col.key
                        ? sort.dir === 1
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                  >
                    {col.sortable !== false ? (
                      // A button, so the sort works from the keyboard (Enter or Space) as well as
                      // the mouse; the th's aria-sort says which way it is sorted.
                      <button type="button" className="th-in" onClick={() => toggleSort(col.key)}>
                        {col.label}
                        {sort.key === col.key && (
                          <span className="sort-ind">
                            {sort.dir === 1 ? (
                              <ArrowUp size={13} aria-hidden="true" />
                            ) : (
                              <ArrowDown size={13} aria-hidden="true" />
                            )}
                          </span>
                        )}
                      </button>
                    ) : (
                      <div className="th-in">{col.label}</div>
                    )}
                  </th>
                ))}
                {rowActions.length > 0 && (
                  <th style={{ width: 56 }} {...cellAttrs(-1, colCount - 1)}>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {virtualize ? (
                <>
                  {padTop > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={totalCols} style={{ height: padTop, padding: 0, border: 0 }} />
                    </tr>
                  )}
                  {virtualItems.map((item) => renderRow(view[item.index], item.index))}
                  {padBottom > 0 && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={totalCols}
                        style={{ height: padBottom, padding: 0, border: 0 }}
                      />
                    </tr>
                  )}
                </>
              ) : (
                view.map((row, r) => renderRow(row, r))
              )}
            </tbody>
          </table>
          {/* Outside the grid, so it keeps its own place in the tab order. */}
          {onAddRow && (
            <button type="button" className="add-row-btn" onClick={onAddRow}>
              <Plus size={16} aria-hidden="true" /> {addLabel}
            </button>
          )}
          {view.length === 0 && (
            <div className="empty">
              <div className="empty-ico">
                <Search size={24} aria-hidden="true" />
              </div>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{emptyText}</div>
              {search && setSearch && (
                <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid-foot">
        <span className="tnum">
          {view.length} {view.length === 1 ? 'record' : 'records'}
        </span>
        {dirty.size > 0 && (
          <span className="badge warning" style={{ height: 18 }}>
            <span className="bdot" /> {dirty.size} edited
          </span>
        )}
        <div className="gf-spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          Arrow keys move · type or Enter to edit · Enter / Tab to commit · Esc to cancel
        </span>
      </div>
    </div>
  );
}

DataGrid.propTypes = {
  columns: PropTypes.array.isRequired,
  rows: PropTypes.array.isRequired,
  getRowId: PropTypes.func,
  onCellChange: PropTypes.func,
  onAddRow: PropTypes.func,
  onRowAction: PropTypes.func,
  rowActions: PropTypes.array,
  selectable: PropTypes.bool,
  selected: PropTypes.instanceOf(Set),
  setSelected: PropTypes.func,
  search: PropTypes.string,
  setSearch: PropTypes.func,
  searchKeys: PropTypes.array,
  toolbar: PropTypes.node,
  toolbarRight: PropTypes.node,
  bulkActions: PropTypes.node,
  onRowClick: PropTypes.func,
  emptyText: PropTypes.string,
  addLabel: PropTypes.string,
  dense: PropTypes.bool,
  label: PropTypes.string,
};
