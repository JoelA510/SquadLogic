import React from 'react';
import PropTypes from 'prop-types';

export default function PersistenceOverridesList({
    overrides,
    totalCount,
    pendingCount,
    onMarkReviewed
}) {
    return (
        <article className="bg-white/5 border border-white/10 rounded-lg p-5 flex flex-col gap-2">
            <h3 className="text-base font-semibold text-blue-300 m-0">Manual Overrides</h3>
            <p className="text-sm text-white/50 mt-auto pt-3 border-t border-white/10">
                {pendingCount} of {totalCount} pending review.
            </p>
            {overrides.length > 0 ? (
                <ul className="list-none p-0 m-2 grid gap-2 max-h-60 overflow-y-auto">
                    {overrides.map((override) => (
                        <li key={override.id} className="p-3 rounded-md bg-white/5 flex justify-between items-start shadow-sm border border-white/5">
                            <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold text-white">{override.teamName}</span>
                                    <span
                                        className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${override.status === 'pending'
                                            ? 'bg-yellow-500/20 text-yellow-400'
                                            : 'bg-green-500/20 text-green-400'
                                            }`}
                                    >
                                        {override.status}
                                    </span>
                                </div>
                                <p className="text-sm text-white/70 m-0">{override.reason}</p>
                            </div>
                            {override.status === 'pending' && (
                                <button
                                    type="button"
                                    className="ml-4 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap"
                                    onClick={() => onMarkReviewed(override.id)}
                                >
                                    Mark Reviewed
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="p-8 text-center text-white/30 italic border border-dashed border-white/10 rounded-lg">
                    No manual overrides detected.
                </div>
            )}
        </article>
    );
}

PersistenceOverridesList.propTypes = {
    overrides: PropTypes.array.isRequired,
    totalCount: PropTypes.number.isRequired,
    pendingCount: PropTypes.number.isRequired,
    onMarkReviewed: PropTypes.func.isRequired,
};
