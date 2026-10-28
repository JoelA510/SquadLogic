import React from 'react';
import { useSeasonReadOnly } from '../../hooks/useSeasonReadOnly.js';

/**
 * Why the generate, apply and save actions of a scheduling page are off: the season shown is
 * completed (Phase E3b). Nothing for any other season.
 */
export default function SeasonReadOnlyNote() {
  if (!useSeasonReadOnly()) return null;
  return (
    <p
      role="note"
      data-testid="season-readonly-note"
      className="mb-4 rounded-lg border border-border-subtle bg-bg-surface px-4 py-2 text-sm text-text-secondary"
    >
      This season is completed and read-only: its teams and schedules cannot be generated, applied
      or saved. Choose the active season in the header to make changes.
    </p>
  );
}
