import React from 'react';
import PropTypes from 'prop-types';

/**
 * A table that may be wider than its column, in a region the keyboard can reach: a scrolling area with nothing
 * focusable in it cannot be scrolled without a mouse (WCAG 2.1.1; axe `scrollable-region-focusable`).
 *
 * @param {{ label: string, children: React.ReactNode }} props
 */
export default function ScrollRegion({ label, children }) {
  return (
    <div
      className="overflow-x-auto mt-2"
      role="region"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard (WCAG 2.1.1)
      tabIndex={0}
    >
      {children}
    </div>
  );
}

/**
 * A body cell of a table of sentences: top-aligned and padded inside, because `table.grid` cells carry no padding of
 * their own (the Practice daylight table does the same).
 *
 * @param {{ children?: React.ReactNode }} props
 */
export function Cell({ children = null }) {
  return (
    <td className="align-top">
      <div className="px-3 py-2 text-sm">{children}</div>
    </td>
  );
}

Cell.propTypes = { children: PropTypes.node };

ScrollRegion.propTypes = {
  label: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
};
