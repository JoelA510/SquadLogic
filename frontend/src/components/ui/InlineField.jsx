import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Pencil } from 'lucide-react';

/**
 * Click-to-edit record field (`.rf*` styles in styles/page.css):
 * a label over a value that turns into an input/select on click;
 * Enter/blur commits (calling onSave only when changed), Esc cancels.
 */
export default function InlineField({
  label,
  value = null,
  type = 'text',
  options = [],
  onSave = undefined,
  render = undefined,
  placeholder = '—',
  editable = true,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!editable && editing) setEditing(false);

  const start = () => {
    setDraft(String(value ?? ''));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    if (!editable) return;
    /** @type {any} */
    let next = draft;
    if (type === 'number') next = draft === '' ? null : Number(draft);
    if (String(next) !== String(value ?? '')) onSave?.(next);
  };

  const handleKey = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
    if (event.key === 'Escape') setEditing(false);
  };

  const displayValue = (
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {render ? (
        render(value)
      ) : value != null && value !== '' ? (
        value
      ) : (
        <span className="muted">{placeholder}</span>
      )}
    </span>
  );

  return (
    <div className="rf">
      <div className="rf-label">{label}</div>
      {editing && editable ? (
        type === 'select' ? (
          <select
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the editor appears because the user just asked to edit; focus moves to it
            autoFocus
            className="select"
            aria-label={label}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={handleKey}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the editor appears because the user just asked to edit; focus moves to it
            autoFocus
            className="input"
            aria-label={label}
            type={type === 'number' ? 'number' : 'text'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={handleKey}
          />
        )
      ) : editable ? (
        <button type="button" className="rf-value" onClick={start}>
          {/* The name comes from the content so it contains the visible value (WCAG 2.5.3);
              the space is a text node because a trailing one inside .sr-only can collapse. */}
          <span className="sr-only">{`Edit ${label}:`}</span> {displayValue}
          <Pencil size={13} className="rf-edit" aria-hidden="true" />
        </button>
      ) : (
        <div className="rf-value">{displayValue}</div>
      )}
    </div>
  );
}

InlineField.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.any,
  type: PropTypes.oneOf(['text', 'number', 'select']),
  options: PropTypes.array,
  onSave: PropTypes.func,
  render: PropTypes.func,
  placeholder: PropTypes.string,
  editable: PropTypes.bool,
};
