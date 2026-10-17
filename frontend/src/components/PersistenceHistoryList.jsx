import React from 'react';
import PropTypes from 'prop-types';
import { formatDateTime } from '../utils/formatters.js';

export default function PersistenceHistoryList({ history }) {
  return (
    <article
      className="bg-bg-glass border border-border-subtle rounded-lg p-5 flex flex-col gap-2"
      aria-labelledby="persistence-history-heading"
    >
      <h3 className="text-base font-semibold text-text-accent m-0" id="persistence-history-heading">
        Recent Supabase Syncs
      </h3>
      {history.length > 0 ? (
        <ul className="list-none p-0 m-2 grid gap-2">
          {history.map((run) => (
            <li
              key={run.runId}
              className="p-3 rounded-md bg-bg-glass shadow-sm border border-border-subtle"
            >
              <div className="flex justify-between mb-1">
                <span className="text-text-accent font-mono text-sm">{run.runId}</span>
                <span
                  className={`text-xs font-semibold ${
                    run.status === 'success'
                      ? 'text-status-success-text'
                      : 'text-status-warning-text'
                  }`}
                >
                  {run.status.toUpperCase()}
                </span>
              </div>
              <p className="text-xs text-text-muted m-0">{formatDateTime(run.startedAt)}</p>
              <p className="text-sm text-text-secondary mt-1">Updated {run.updatedTeams} teams</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-8 text-center text-text-muted italic border border-dashed border-border-subtle rounded-lg">
          No sync history available.
        </div>
      )}
    </article>
  );
}

PersistenceHistoryList.propTypes = {
  history: PropTypes.array.isRequired,
};
