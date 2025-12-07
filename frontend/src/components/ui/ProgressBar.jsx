import React from 'react';
import PropTypes from 'prop-types';

const ProgressBar = ({ progress, label, showPercentage = true, className = '' }) => {
    return (
        <div className={`w-full ${className}`}>
            <div className="flex justify-between items-center mb-2">
                {label && <span className="text-sm font-medium text-blue-200">{label}</span>}
                {showPercentage && <span className="text-sm font-bold text-blue-400">{Math.round(progress)}%</span>}
            </div>
            <div className="h-4 bg-black/40 rounded-full overflow-hidden border border-white/5 relative">
                {/* Background Glow */}
                <div className="absolute inset-0 bg-blue-500/5" />

                {/* Progress Fill */}
                <div
                    className="h-full bg-gradient-to-r from-blue-600 via-cyan-400 to-blue-400 relative transition-all duration-300 ease-out"
                    style={{ width: `${progress}%` }}
                >
                    {/* Shimmer Effect */}
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent w-full -translate-x-full animate-[shimmer_2s_infinite]" />

                    {/* Glow at the tip */}
                    <div className="absolute right-0 top-0 bottom-0 w-2 bg-white/50 blur-[2px]" />
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-4 h-4 bg-blue-400 rounded-full blur-md" />
                </div>
            </div>
        </div>
    );
};

ProgressBar.propTypes = {
    progress: PropTypes.number.isRequired,
    label: PropTypes.string,
    showPercentage: PropTypes.bool,
    className: PropTypes.string
};

export default ProgressBar;
