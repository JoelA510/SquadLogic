import React from 'react';
import PropTypes from 'prop-types';

export default function PersistenceOverridesList({
  overrides,
  pendingCount,
  totalCount,
  onMarkReviewed,
}) {
  return (
    <article
      className="bg-bg-glass border border-border-subtle rounded-lg p-5 flex flex-col gap-2"
      aria-labelledby="manual-overrides-heading"
    >
      <h3 className="text-base font-semibold text-text-accent m-0" id="manual-overrides-heading">
        Manual Overrides
      </h3>
      <p className="text-sm text-text-muted mt-auto pt-3 border-t border-border-subtle">
        {pendingCount} of {totalCount} pending review.
      </p>
      {overrides.length > 0 ? (
        <ul className="list-none p-0 mt-2 grid gap-2">
          {overrides.map((override) => (
            <li
              key={override.id}
              className="p-3 rounded-md bg-bg-glass flex justify-between items-center border border-border-subtle"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-secondary truncate">
                  {override.playerName}
                </p>
                <p className="text-xs text-text-muted truncate">
                  {override.divisionId} · {override.type}
                </p>
              </div>
              {override.status === 'pending' && (
                <button
                  type="button"
                  className="glass-button-secondary ml-4"
                  onClick={() => onMarkReviewed(override.id)}
                >
                  Mark Reviewed
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-8 text-center text-text-muted italic border border-dashed border-border-subtle rounded-lg">
          No manual overrides found.
        </div>
      )}
    </article>
  );
}

PersistenceOverridesList.propTypes = {
  overrides: PropTypes.array.isRequired,
  pendingCount: PropTypes.number.isRequired,
  totalCount: PropTypes.number.isRequired,
  onMarkReviewed: PropTypes.func.isRequired,
};
