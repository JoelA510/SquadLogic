import React from 'react';
import PropTypes from 'prop-types';
import { formatDateTime } from '../utils/formatDateTime.js';

export default function PersistenceHistoryList({ history }) {
    return (
        <article className="bg-white/5 border border-white/10 rounded-lg p-5 flex flex-col gap-2">
            <h3 className="text-base font-semibold text-blue-300 m-0">Recent Supabase Syncs</h3>
            {history.length > 0 ? (
                <ul className="list-none p-0 m-2 grid gap-2">
                    {history.map((run) => (
                        <li key={run.runId} className="p-3 rounded-md bg-white/5 shadow-sm border border-white/5">
                            <div className="flex justify-between mb-1">
                                <span className="text-blue-300 font-mono text-sm">{run.runId}</span>
                                <span
                                    className={`text-xs font-semibold ${run.status === 'success' ? 'text-green-400' : 'text-yellow-400'
                                        }`}
                                >
                                    {run.status.toUpperCase()}
                                </span>
                            </div>
                            <p className="text-xs text-white/50 m-0">
                                {formatDateTime(run.startedAt)}
                            </p>
                            <p className="text-sm text-white/80 mt-1">
                                Updated {run.updatedTeams} teams
                            </p>
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="p-8 text-center text-white/30 italic border border-dashed border-white/10 rounded-lg">
                    No sync history available.
                </div>
            )}
        </article>
    );
}

PersistenceHistoryList.propTypes = {
    history: PropTypes.array.isRequired,
};
