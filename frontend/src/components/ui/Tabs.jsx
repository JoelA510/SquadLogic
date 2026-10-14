import React, { useId, useRef } from 'react';
import PropTypes from 'prop-types';

/**
 * Accessible tab strip (roving tabindex, arrow-key navigation).
 * Styles from `.page-tabs` / `.page-tab` in styles/page.css.
 *
 * Renders only the tablist; the active panel is the caller's concern
 * (pass `panelId` so aria-controls points at it).
 *
 * @param {Object} props
 * @param {Array<{ id: string, label: React.ReactNode, badge?: React.ReactNode }>} props.tabs
 * @param {string} props.activeTab - id of the active tab.
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.panelId] - id of the panel the active tab controls.
 * @param {string} [props.label] - Accessible name of the tablist.
 * @param {string} [props.className]
 */
export default function Tabs({ tabs, activeTab, onChange, panelId, label, className = '' }) {
  const listRef = useRef(null);
  const baseId = useId();

  const handleKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === activeTab);
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    const next = tabs[nextIndex];
    onChange(next.id);
    listRef.current?.querySelector(`#${CSS.escape(`${baseId}-${next.id}`)}`)?.focus();
  };

  return (
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the tablist delegates its tabs' arrow keys; each tab is a focusable button (roving tabindex)
    <div
      ref={listRef}
      className={`page-tabs ${className}`.trim()}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            id={`${baseId}-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={isActive ? panelId : undefined}
            tabIndex={isActive ? 0 : -1}
            className={`page-tab ${isActive ? 'active' : ''}`.trim()}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}

Tabs.propTypes = {
  tabs: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.node.isRequired,
      badge: PropTypes.node,
    })
  ).isRequired,
  activeTab: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  panelId: PropTypes.string,
  label: PropTypes.string,
  className: PropTypes.string,
};
