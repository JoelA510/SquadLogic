import React from 'react';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';

/**
 * A line above the page when the season shown is not the live one (Phase E3b): a draft is being
 * prepared and is not live until it is activated; a completed season is history and read-only.
 * The active season shows nothing.
 */
export default function SeasonStatusNotice() {
  const { currentSeasonSetting } = useOrganization();
  const status = currentSeasonSetting?.status;
  if (status !== 'draft' && status !== 'completed') return null;
  return (
    <p
      role="status"
      data-testid="season-status-notice"
      className="mb-4 rounded-lg border border-border-subtle bg-bg-surface px-4 py-2 text-sm text-text-secondary"
    >
      {status === 'draft'
        ? `"${currentSeasonSetting.name}" is a draft season: it is not live until it is activated in Settings > Season & Calendar.`
        : `"${currentSeasonSetting.name}" is a completed season: it is read-only.`}
    </p>
  );
}
