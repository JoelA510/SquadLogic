/**
 * Keyboard model for DataGrid, a `role="grid"` with one tab stop (WAI-ARIA APG, data grid).
 *
 * Positions are `{ r, c }` over every rendered cell: `r` is -1 for the header row, then 0.. for
 * the rows in view; `c` counts the selection column (when there is one), the data columns, then
 * the row-actions column (when there is one). DataGrid marks each cell with `data-grid-cell`,
 * `data-r` and `data-c`.
 *
 * Arrows, Home and End (Ctrl+Home / Ctrl+End for the first and last cell) move focus between
 * cells; Left and Right first step through the widgets of a cell that holds several. Enter, F2 or
 * typing edits an editable cell; Backspace or Delete clears into an edit; Space toggles the row's
 * selection. Tab is never the grid's: it moves focus out (WCAG 2.1.2). On a widget inside a cell
 * (a checkbox, a sort button, a link), Enter and Space are the widget's own; a menu opened inside a
 * cell and a form control keep all their keys.
 */

/** Focusable descendants of a cell, other than the cell itself and anything in an open menu. */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), [tabindex]:not([data-grid-cell])';

/**
 * The widgets a cell holds, in order.
 * @param {Element} cell
 * @returns {HTMLElement[]}
 */
export function cellWidgets(cell) {
  return allFocusables(cell).filter((el) => !el.closest('[role="menu"]'));
}

/**
 * Every focusable element in a cell, menus included (all of them leave the tab order).
 * @param {Element} cell
 * @returns {HTMLElement[]}
 */
export function allFocusables(cell) {
  return Array.from(cell.querySelectorAll(FOCUSABLE)).filter((el) => el instanceof HTMLElement);
}

/**
 * Where focus goes for a cell: its first widget, or the cell itself when it holds none.
 * @param {HTMLElement} cell
 * @returns {HTMLElement}
 */
export function focusTargetOf(cell) {
  return cellWidgets(cell)[0] || cell;
}

const OWN_KEYS_SELECTOR = 'input, select, textarea, [role="menu"], [contenteditable="true"]';

export function useGridKeyboard({
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
  onActiveMove,
}) {
  const lastRow = view.length - 1;

  const moveTo = (event, next) => {
    event.preventDefault();
    const r = Math.min(lastRow, Math.max(-1, next.r));
    const c = Math.min(colCount - 1, Math.max(0, next.c));
    const target = { r, c };
    setActive(target);
    requestFocus();
    if (r >= 0) onActiveMove?.(target);
  };

  const onKeyDown = (event) => {
    if (editing) return;
    const { target } = event;
    if (!(target instanceof Element)) return;
    // A form control or a menu inside a cell owns its keys (a menu's arrows move its items).
    if (target.closest(OWN_KEYS_SELECTOR)) return;
    const cell = target.closest('[data-grid-cell]');
    if (!(cell instanceof HTMLElement)) return;
    const onWidget = target !== cell;
    // The focused cell is the position: focus and the active cell move together (DataGrid's onFocus).
    const pos = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
    const dataCol = pos.r >= 0 ? columns[pos.c - colOffset] : undefined;
    const editable = !!dataCol?.editable;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        const step = event.key === 'ArrowRight' ? 1 : -1;
        if (onWidget) {
          const widgets = cellWidgets(cell);
          const sibling = widgets[widgets.indexOf(/** @type {HTMLElement} */ (target)) + step];
          if (sibling) {
            event.preventDefault();
            /** @type {HTMLElement} */ (target).tabIndex = -1;
            sibling.tabIndex = 0;
            sibling.focus();
            return;
          }
        }
        moveTo(event, { r: pos.r, c: pos.c + step });
        return;
      }
      case 'ArrowDown':
        moveTo(event, { r: pos.r + 1, c: pos.c });
        return;
      case 'ArrowUp':
        moveTo(event, { r: pos.r - 1, c: pos.c });
        return;
      case 'Home':
        moveTo(event, event.ctrlKey ? { r: -1, c: 0 } : { r: pos.r, c: 0 });
        return;
      case 'End':
        moveTo(
          event,
          event.ctrlKey ? { r: lastRow, c: colCount - 1 } : { r: pos.r, c: colCount - 1 }
        );
        return;
      case 'Enter':
      case 'F2':
        if (onWidget || !editable) return;
        event.preventDefault();
        startEdit(pos.r, pos.c - colOffset);
        return;
      case ' ':
        if (onWidget || !selectable || pos.r < 0) return;
        event.preventDefault();
        toggleRow(getRowId(view[pos.r]));
        return;
      case 'Backspace':
      case 'Delete':
        if (onWidget || !editable || dataCol.type === 'select') return;
        event.preventDefault();
        startEdit(pos.r, pos.c - colOffset, '');
        return;
      default:
        if (
          !onWidget &&
          editable &&
          dataCol.type !== 'select' &&
          event.key.length === 1 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          startEdit(pos.r, pos.c - colOffset, event.key);
        }
    }
  };

  return { onKeyDown };
}
