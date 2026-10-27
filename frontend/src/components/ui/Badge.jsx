import React from 'react';
import PropTypes from 'prop-types';

/**
 * Status badge / pill. Styles from `.badge` in styles/page.css.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {'neutral' | 'success' | 'warning' | 'danger' | 'info'} [props.tone]
 * @param {boolean} [props.dot] - Show a leading status dot.
 * @param {boolean} [props.square] - Square corners instead of pill.
 * @param {string} [props.className]
 * @param {string} [props.title]
 */
export default function Badge({
  children,
  tone = 'neutral',
  dot = false,
  square = false,
  className = '',
  ...props
}) {
  const classes = ['badge', tone, square ? 'square' : '', className].filter(Boolean).join(' ');
  return (
    <span className={classes} {...props}>
      {dot && <span className="bdot" aria-hidden="true" />}
      {children}
    </span>
  );
}

Badge.propTypes = {
  children: PropTypes.node.isRequired,
  tone: PropTypes.oneOf(['neutral', 'success', 'warning', 'danger', 'info']),
  dot: PropTypes.bool,
  square: PropTypes.bool,
  className: PropTypes.string,
  title: PropTypes.string,
};
