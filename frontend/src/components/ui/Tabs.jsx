import React, { useId, useRef } from 'react';
import PropTypes from 'prop-types';

/**
 * Accessible tab strip (roving tabindex, arrow-key navigation).
 * Styles from `.page-tabs` / `.page-tab` in styles/page.css.
 *
 * Renders only the tablist; the active panel is the caller's concern
 * (pass `panelId` so aria-controls points at it).
 *
 * A tab can be `disabled` while its view means nothing (the game grid's By Team during Manual
 * Override): it stays in the strip, cannot be chosen by click or arrow key, and names its reason
 * through `describedBy`, the id of visible text the caller renders beside the strip.
 *
 * @param {Object} props
 * @param {Array<{ id: string, label: React.ReactNode, badge?: React.ReactNode,
 *   disabled?: boolean, describedBy?: string }>} props.tabs
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
    // Arrow keys, Home and End move among the tabs that can be chosen.
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    const index = enabled.findIndex((tab) => tab.id === activeTab);
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + enabled.length) % enabled.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % enabled.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = enabled.length - 1;
    const next = enabled[nextIndex];
    // A key that lands on the selected tab (the only one that can be chosen) changes nothing.
    if (next.id !== activeTab) onChange(next.id);
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
            disabled={tab.disabled || undefined}
            aria-describedby={tab.describedBy}
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
      disabled: PropTypes.bool,
      describedBy: PropTypes.string,
    })
  ).isRequired,
  activeTab: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  panelId: PropTypes.string,
  label: PropTypes.string,
  className: PropTypes.string,
};
