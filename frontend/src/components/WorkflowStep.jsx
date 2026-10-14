import React from 'react';
import PropTypes from 'prop-types';
import { Clock, Play, CheckCircle, Lock } from 'lucide-react';

const WorkflowStep = ({
  title,
  description,
  status = 'pending', // pending, active, completed, locked
  onClick,
  children,
}) => {
  const isLocked = status === 'locked';
  const isActive = status === 'active';
  const isCompleted = status === 'completed';

  const baseClasses =
    'relative transition-all duration-300 mb-6 p-4 sm:p-6 group min-w-0 overflow-visible';

  const statusStyles = {
    pending: 'glass-panel-premium opacity-70 hover:opacity-100 border-l-4 border-l-border-subtle',
    active:
      'glass-panel-premium border-l-4 border-l-brand-DEFAULT shadow-[0_0_30px_rgba(59,130,246,0.15)]',
    completed: 'glass-panel-premium border-l-4 border-l-status-success opacity-90',
    locked:
      'glass-panel-premium opacity-40 grayscale cursor-not-allowed border-l-4 border-l-transparent',
  };

  const iconStyles = {
    pending: 'bg-bg-surface text-text-muted',
    active: 'bg-brand text-white shadow-lg', // Keep text-white for active icon as it has solid bg
    completed: 'bg-status-success text-white',
    locked: 'bg-bg-surface text-text-muted',
  };

  const icons = {
    pending: <Clock className="w-5 h-5" />,
    active: <Play className="w-5 h-5" />,
    completed: <CheckCircle className="w-5 h-5" />,
    locked: <Lock className="w-5 h-5" />,
  };

  const statusLabels = {
    pending: 'Next Step',
    active: 'In Progress',
    completed: 'Completed',
    locked: 'Locked',
  };

  return (
    // A collapsed card opens on a click anywhere on it; the keyboard path is the heading's button.
    // An open card takes no click of its own, so a control inside it (a "proceed" button) isn't
    // undone by the card re-selecting its step.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the card's click repeats the heading button, which is the keyboard path
    <div
      data-testid={`workflow-step-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className={`${baseClasses} ${statusStyles[status]} ${!isLocked && !isActive ? 'cursor-pointer transform hover:scale-[1.01]' : ''}`}
      onClick={!isLocked && !isActive ? onClick : undefined}
    >
      {/* Active Indicator Glow */}
      {isActive && (
        <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-[50px] rounded-full -mr-10 -mt-10 pointer-events-none" />
      )}

      <div className="flex items-start gap-4 relative z-10 min-w-0">
        {/* Status Icon */}
        <div
          className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors duration-300 ${iconStyles[status]}`}
        >
          {icons[status]}
        </div>

        {/* Content Header */}
        <div className="flex-grow min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-1 min-w-0">
            <h2
              className={`text-xl font-display font-bold transition-colors min-w-0 ${isActive ? 'text-text-primary' : 'text-text-secondary'}`}
            >
              {/* The step's keyboard control (Enter or Space). It stops its click here so the
                  card's own click handler doesn't run the step change twice. */}
              <button
                type="button"
                className="text-left min-w-0 disabled:cursor-not-allowed"
                aria-expanded={isActive}
                disabled={isLocked}
                onClick={(event) => {
                  event.stopPropagation();
                  onClick?.();
                }}
              >
                {title}
              </button>
            </h2>
            <span
              className={`shrink-0 self-start sm:self-auto text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full ${
                isActive
                  ? 'bg-brand/10 text-text-accent border border-brand/20'
                  : isCompleted
                    ? 'bg-status-success/10 text-status-success-text border border-status-success/20'
                    : 'bg-bg-surface text-text-muted border border-border-subtle'
              }`}
            >
              {statusLabels[status]}
            </span>
          </div>

          <p
            className={`text-sm leading-relaxed transition-colors ${isActive ? 'text-text-secondary' : 'text-text-muted'}`}
          >
            {description}
          </p>
        </div>
      </div>

      {/* Expanded Content. Collapsed, it is inert: out of the tab order and the accessibility
          tree, as the heading's aria-expanded="false" says. */}
      <div
        inert={!isActive}
        className={`grid min-w-0 transition-all duration-500 ease-in-out ${
          isActive
            ? 'grid-rows-[1fr] opacity-100 mt-6 overflow-visible'
            : 'grid-rows-[0fr] opacity-0 overflow-hidden'
        }`}
      >
        <div className={`${isActive ? 'overflow-visible' : 'overflow-hidden'} min-w-0`}>
          <div className="pt-4 border-t border-border-subtle animate-slideUp min-w-0">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};

WorkflowStep.propTypes = {
  title: PropTypes.string.isRequired,
  description: PropTypes.string.isRequired,
  status: PropTypes.oneOf(['pending', 'active', 'completed', 'locked']),
  onClick: PropTypes.func,
  children: PropTypes.node,
};

export default WorkflowStep;
