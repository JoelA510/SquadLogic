import React from 'react';
import PropTypes from 'prop-types';
import { Clock, Play, CheckCircle, Lock } from 'lucide-react';

const WorkflowStep = ({
    title,
    description,
    status = 'pending', // pending, active, completed, locked
    onClick,
    children
}) => {
    const isLocked = status === 'locked';
    const isActive = status === 'active';
    const isCompleted = status === 'completed';

    const baseClasses = "relative overflow-hidden transition-all duration-300 mb-6 p-6 group";

    const statusStyles = {
        pending: "glass-panel-premium opacity-70 hover:opacity-100 border-l-4 border-l-border-subtle",
        active: "glass-panel-premium border-l-4 border-l-brand-DEFAULT shadow-[0_0_30px_rgba(59,130,246,0.15)]",
        completed: "glass-panel-premium border-l-4 border-l-status-success opacity-90",
        locked: "glass-panel-premium opacity-40 grayscale cursor-not-allowed border-l-4 border-l-transparent"
    };

    const iconStyles = {
        pending: "bg-bg-surface text-text-muted",
        active: "bg-brand-DEFAULT text-white shadow-lg shadow-brand-glow", // Keep text-white for active icon as it has solid bg
        completed: "bg-status-success text-white",
        locked: "bg-bg-surface text-text-muted"
    };

    const icons = {
        pending: <Clock className="w-5 h-5" />,
        active: <Play className="w-5 h-5" />,
        completed: <CheckCircle className="w-5 h-5" />,
        locked: <Lock className="w-5 h-5" />
    };

    const statusLabels = {
        pending: 'Next Step',
        active: 'In Progress',
        completed: 'Completed',
        locked: 'Locked'
    };

    return (
        <div
            className={`${baseClasses} ${statusStyles[status]} ${!isLocked ? 'cursor-pointer transform hover:scale-[1.01]' : ''}`}
            onClick={!isLocked ? onClick : undefined}
        >
            {/* Active Indicator Glow */}
            {isActive && (
                <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-[50px] rounded-full -mr-10 -mt-10 pointer-events-none" />
            )}

            <div className="flex items-start gap-4 relative z-10">
                {/* Status Icon */}
                <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors duration-300 ${iconStyles[status]}`}>
                    {icons[status]}
                </div>

                {/* Content Header */}
                <div className="flex-grow">
                    <div className="flex items-center justify-between mb-1">
                        <h2 className={`text-xl font-display font-bold transition-colors ${isActive ? 'text-text-primary' : 'text-text-secondary'}`}>
                            {title}
                        </h2>
                        <span className={`text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full ${isActive ? 'bg-brand-DEFAULT/10 text-brand-DEFAULT border border-brand-DEFAULT/20' :
                            isCompleted ? 'bg-status-success/10 text-status-success border border-status-success/20' :
                                'bg-bg-surface text-text-muted border border-border-subtle'
                            }`}>
                            {statusLabels[status]}
                        </span>
                    </div>

                    <p className={`text-sm leading-relaxed transition-colors ${isActive ? 'text-text-secondary' : 'text-text-muted'}`}>
                        {description}
                    </p>
                </div>
            </div>

            {/* Expanded Content */}
            <div className={`grid transition-all duration-500 ease-in-out ${isActive ? 'grid-rows-[1fr] opacity-100 mt-6' : 'grid-rows-[0fr] opacity-0'}`}>
                <div className="overflow-hidden">
                    <div className="pt-4 border-t border-border-subtle animate-slideUp">
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
    children: PropTypes.node
};

export default WorkflowStep;
