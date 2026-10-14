import React from 'react';
import PropTypes from 'prop-types';

const SIDE_CLASSES = {
  top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-2 -translate-x-1/2',
  left: 'right-full top-1/2 mr-2 -translate-y-1/2',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2',
};

const mergeDescribedBy = (existing, tooltipId) =>
  [existing, tooltipId].filter(Boolean).join(' ') || undefined;

const isAriaDisabled = (value) => value === true || value === 'true';

export default function Tooltip({
  content,
  children,
  className = '',
  side = 'top',
  tooltipClassName = '',
}) {
  const generatedId = React.useId();
  const tooltipId = `tooltip-${generatedId}`;

  if (!content) {
    return children;
  }

  const child = React.Children.only(children);
  const childProps = React.isValidElement(child) ? child.props : {};
  const disabled = childProps.disabled === true || isAriaDisabled(childProps['aria-disabled']);
  const childWithDescription = React.isValidElement(child)
    ? React.cloneElement(child, {
        'aria-describedby': mergeDescribedBy(childProps['aria-describedby'], tooltipId),
      })
    : child;

  return (
    <span
      className={`relative inline-flex min-w-0 group/tooltip ${className}`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- only when the wrapped control is disabled (and so unfocusable): keeps its explanation reachable by keyboard
      tabIndex={disabled ? 0 : undefined}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? tooltipId : undefined}
    >
      {childWithDescription}
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute z-[100] max-w-[16rem] rounded-md border border-border-highlight bg-bg-surface px-3 py-2 text-xs leading-snug text-text-primary shadow-md invisible opacity-0 transition-opacity duration-150 delay-150 group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100 ${SIDE_CLASSES[side]} ${tooltipClassName}`}
      >
        {content}
      </span>
    </span>
  );
}

Tooltip.propTypes = {
  content: PropTypes.node,
  children: PropTypes.element.isRequired,
  className: PropTypes.string,
  side: PropTypes.oneOf(['top', 'bottom', 'left', 'right']),
  tooltipClassName: PropTypes.string,
};
