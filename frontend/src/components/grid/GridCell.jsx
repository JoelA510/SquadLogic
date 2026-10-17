import React from 'react';
import PropTypes from 'prop-types';

function renderCellContent(row, col) {
  if (col.render) return col.render(row);
  const value = row[col.key];
  if (col.type === 'select' && col.optionLabel) return col.optionLabel(value);
  if (value == null || value === '') return <span className="muted">{col.placeholder || '—'}</span>;
  return value;
}

/**
 * One body cell of the DataGrid: displays the value, the focus outline,
 * the dirty corner marker, or the active editor (input/select). An editor
 * that loses focus commits without taking focus back (DataGrid's commitEdit).
 */
export default function GridCell({
  row,
  col,
  isActive = false,
  isEditing = false,
  isDirty = false,
  editVal = '',
  setEditVal = undefined,
  inputRef = undefined,
  onEditKey = undefined,
  onCommit = undefined,
  onMouseDown = undefined,
  onClick = undefined,
  onDoubleClick = undefined,
  stickyLeft = undefined,
  cellProps = undefined,
}) {
  return (
    <td
      {...cellProps}
      className={[
        col.editable ? 'editable' : '',
        col.sticky ? 'sticky-col' : '',
        isActive && !isEditing ? 'cell-focus' : '',
        isDirty ? 'dirty' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={col.sticky ? { left: stickyLeft } : undefined}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {isEditing ? (
        col.type === 'select' ? (
          <select
            ref={inputRef}
            className="cell-input"
            aria-label={col.label}
            value={editVal}
            onChange={(event) => setEditVal(event.target.value)}
            onBlur={() => onCommit()}
            onKeyDown={onEditKey}
          >
            {col.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={inputRef}
            className="cell-input"
            aria-label={col.label}
            type={col.type === 'number' ? 'number' : 'text'}
            min={col.min}
            max={col.max}
            value={editVal}
            onChange={(event) => setEditVal(event.target.value)}
            onBlur={() => onCommit()}
            onKeyDown={onEditKey}
          />
        )
      ) : (
        <div className={`cell ${col.num ? 'num' : ''} ${col.center ? 'center' : ''}`.trim()}>
          {renderCellContent(row, col)}
        </div>
      )}
    </td>
  );
}

GridCell.propTypes = {
  row: PropTypes.object.isRequired,
  col: PropTypes.object.isRequired,
  isActive: PropTypes.bool,
  isEditing: PropTypes.bool,
  isDirty: PropTypes.bool,
  editVal: PropTypes.string,
  setEditVal: PropTypes.func,
  inputRef: PropTypes.object,
  onEditKey: PropTypes.func,
  onCommit: PropTypes.func,
  onMouseDown: PropTypes.func,
  onClick: PropTypes.func,
  onDoubleClick: PropTypes.func,
  stickyLeft: PropTypes.number,
  /** The grid's cell attributes (role, data-grid-cell, data-r, data-c), from DataGrid. */
  cellProps: PropTypes.object,
};
