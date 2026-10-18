import React, { useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Check } from 'lucide-react';

/**
 * Anchored dropdown menu. The trigger is render-prop'd so any element can
 * open it; items render in a `.menu` popover (styles/chrome.css).
 *
 * Keyboard (WAI-ARIA APG menu button): with the menu open, Up and Down move
 * through the items, Home and End jump, Escape closes it and returns focus to
 * the trigger, and Tab closes it and moves on. The items are never tab stops.
 *
 * @param {Object} props
 * @param {(args: { open: boolean, toggle: () => void, triggerProps: Object }) => React.ReactNode} props.renderTrigger
 * @param {Array<{ id: string, label: React.ReactNode, icon?: React.ElementType, danger?: boolean, checked?: boolean, separatorAbove?: boolean, onSelect?: () => void }>} props.items
 * @param {React.ReactNode} [props.header] - Optional `.menu-label` heading.
 * @param {boolean} [props.alignRight]
 * @param {string} [props.className]
 */
export default function Dropdown({
  renderTrigger,
  items,
  header,
  alignRight = true,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement;
    const handlePointer = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const handleKey = (event) => {
      const menuItems = Array.from(rootRef.current?.querySelectorAll('[role="menuitem"]') || []);
      if (event.key === 'Escape') {
        setOpen(false);
        // Return focus to the trigger so keyboard users keep their place.
        if (trigger instanceof HTMLElement) trigger.focus();
        return;
      }
      // Tab closes the menu and moves on as if from the trigger (WAI-ARIA APG menu button):
      // focus goes back to the trigger first, and the browser's own Tab, which runs after this
      // handler, moves from there. Left on an item that the close unmounts, the browser would
      // restart from the menu's container, which holds the trigger.
      if (event.key === 'Tab') {
        if (trigger instanceof HTMLElement && rootRef.current?.contains(document.activeElement)) {
          trigger.focus();
        }
        setOpen(false);
        return;
      }
      if (menuItems.length === 0) return;
      const index = menuItems.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next =
          index === -1
            ? menuItems[event.key === 'ArrowDown' ? 0 : menuItems.length - 1]
            : menuItems[
                (index + (event.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length
              ];
        next.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        menuItems[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        menuItems[menuItems.length - 1].focus();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const toggle = () => setOpen((value) => !value);

  return (
    <div ref={rootRef} className={`popover-anchor ${className}`.trim()}>
      {renderTrigger({
        open,
        toggle,
        triggerProps: {
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? menuId : undefined,
        },
      })}
      {open && (
        <div className={`popover ${alignRight ? 'right' : ''}`.trim()}>
          <div className="menu" role="menu" id={menuId}>
            {header && <div className="menu-label">{header}</div>}
            {items.map((item) => (
              <React.Fragment key={item.id}>
                {item.separatorAbove && <div className="menu-sep" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  // Reached with the arrow keys, never with Tab (APG menu pattern): a menu opened
                  // inside a composite such as DataGrid must not add tab stops to it.
                  tabIndex={-1}
                  className={`menu-item ${item.danger ? 'danger' : ''}`.trim()}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect?.();
                  }}
                >
                  {item.icon && <item.icon size={15} aria-hidden="true" />}
                  {item.label}
                  {item.checked && <Check size={15} className="mi-check" aria-hidden="true" />}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

Dropdown.propTypes = {
  renderTrigger: PropTypes.func.isRequired,
  items: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.node.isRequired,
      icon: PropTypes.elementType,
      danger: PropTypes.bool,
      checked: PropTypes.bool,
      separatorAbove: PropTypes.bool,
      onSelect: PropTypes.func,
    })
  ).isRequired,
  header: PropTypes.node,
  alignRight: PropTypes.bool,
  className: PropTypes.string,
};
