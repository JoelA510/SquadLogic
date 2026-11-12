import React from 'react';

/**
 * A score that was not saved, said on the page (an alert that stays, not a toast and not `window.alert`). Used by the
 * Scores page and the Standings page so the two read the same.
 *
 * @param {{ message: string | null, className?: string }} props - nothing is drawn without a message
 */
export default function ScoreNotSavedAlert({ message, className = '' }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="score-not-saved"
      className={`rounded-lg border border-status-error/30 bg-status-error-bg px-4 py-2 text-sm font-medium text-status-error ${className}`}
    >
      {message}
    </p>
  );
}
