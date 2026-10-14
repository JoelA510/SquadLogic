/**
 * Spreadsheet keyboard model for DataGrid:
 * arrows move the active cell, Enter/F2 edits, typing starts an edit with
 * the typed character, Backspace/Delete clears into an edit, Space toggles
 * row selection, Tab moves horizontally (skipping non-editable columns).
 */
export function useGridKeyboard({
  view,
  columns,
  active,
  setActive,
  editing,
  startEdit,
  selectable,
  toggleRow,
  getRowId,
  onActiveMove,
}) {
  const firstEditableCol = () => {
    const index = columns.findIndex((col) => col.editable);
    return Math.max(0, index);
  };

  const moveActive = (dr, dc) => {
    setActive((current) => {
      const base = current || { r: 0, c: firstEditableCol() };
      const nr = Math.min(view.length - 1, Math.max(0, base.r + dr));
      let nc = base.c + dc;
      if (dc !== 0) {
        while (nc >= 0 && nc < columns.length && !columns[nc].editable) {
          nc += dc > 0 ? 1 : -1;
        }
      }
      nc = Math.min(columns.length - 1, Math.max(0, nc));
      const next = { r: nr, c: nc };
      onActiveMove?.(next);
      return next;
    });
  };

  const onKeyDown = (event) => {
    if (editing) return;
    // Only keys pressed on the grid itself: a control inside it (a header's sort button, a
    // selection checkbox, a row action) keeps its own Enter, Space and Tab.
    if (event.target !== event.currentTarget) return;
    if (!active) {
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) {
        event.preventDefault();
        const next = { r: 0, c: firstEditableCol() };
        setActive(next);
        onActiveMove?.(next);
      }
      return;
    }
    const col = columns[active.c];
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1, 0);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveActive(0, -1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveActive(0, 1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      moveActive(0, event.shiftKey ? -1 : 1);
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      if (col?.editable) startEdit(active.r, active.c);
    } else if (event.key === ' ' && selectable) {
      event.preventDefault();
      toggleRow(getRowId(view[active.r]));
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      if (col?.editable && col.type !== 'select') {
        event.preventDefault();
        startEdit(active.r, active.c, '');
      }
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      col?.editable &&
      col.type !== 'select'
    ) {
      startEdit(active.r, active.c, event.key);
    }
  };

  return { onKeyDown, moveActive };
}
