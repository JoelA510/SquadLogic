import React from 'react';
import PropTypes from 'prop-types';

/**
 * Lightning-class button. Styles come from `.btn*` classes in styles/page.css.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {'primary' | 'secondary' | 'danger' | 'ghost' | 'ghost-danger'} [props.variant]
 * @param {'sm' | 'md' | 'lg'} [props.size]
 * @param {string} [props.className]
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.loading]
 * @param {React.MouseEventHandler<HTMLButtonElement>} [props.onClick]
 * @param {'button' | 'submit' | 'reset'} [props.type]
 * @param {React.ElementType} [props.icon]
 * @param {string} [props.title]
 * @param {React.Ref<HTMLButtonElement>} [props.ref] - React 19 passes `ref` as a prop
 * @param {string} [props.form] - the id of the form a `submit` button belongs to, when it sits outside it
 */
const Button = ({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  disabled = false,
  loading = false,
  onClick,
  type = 'button',
  icon: Icon,
  ...props
}) => {
  const variants = {
    primary: 'btn-primary',
    secondary: 'btn-default',
    danger: 'btn-danger',
    ghost: 'btn-subtle',
    'ghost-danger': 'btn-ghost-danger',
  };

  const sizes = {
    sm: 'sm',
    md: '',
    lg: 'lg',
  };

  return (
    <button
      type={type}
      className={`btn ${variants[variant]} ${sizes[size]} ${className}`.trim()}
      disabled={disabled || loading}
      onClick={onClick}
      {...props}
    >
      {loading ? (
        <span className="spinner" role="status" aria-label="Loading" />
      ) : (
        Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" />
      )}
      {children}
    </button>
  );
};

Button.propTypes = {
  children: PropTypes.node.isRequired,
  variant: PropTypes.oneOf(['primary', 'secondary', 'danger', 'ghost', 'ghost-danger']),
  size: PropTypes.oneOf(['sm', 'md', 'lg']),
  className: PropTypes.string,
  disabled: PropTypes.bool,
  loading: PropTypes.bool,
  onClick: PropTypes.func,
  type: PropTypes.oneOf(['button', 'submit', 'reset']),
  icon: PropTypes.elementType,
  title: PropTypes.string,
};

export default Button;
