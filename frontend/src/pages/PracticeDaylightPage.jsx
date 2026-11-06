import React from 'react';
import { Sunset } from 'lucide-react';
import { Link } from 'react-router-dom';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import DaylightOutlook from '../components/daylight/DaylightOutlook.jsx';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { usePracticeDaylightOutlook } from '../hooks/usePracticeDaylightOutlook.js';

/**
 * Practice daylight (duration-phase wiring, PR B of
 * `docs/changes/2026-11-02-duration-phases-wiring.md`; owner, 2026-11-02:
 * "Wire the durationPhases as recommended.", "Go with A"): a read-only outlook
 * of what the rest of the season does to each practice slot on unlit ground.
 *
 * It reads the same rows as the Practices page, under the same permission
 * (`VIEW_SCHEDULE`), changes nothing and stores nothing, and has no feature
 * flag (daylight is a ruling for every league, and the page is read-only).
 * Applying a retimed length is not part of it.
 */
export default function PracticeDaylightPage() {
  const { currentOrganization, currentSeasonSetting, seasonSettingsLoading } = useOrganization();
  const orgId = currentOrganization?.id ? String(currentOrganization.id) : null;
  const outlook = usePracticeDaylightOutlook({
    organizationId: orgId,
    season: currentSeasonSetting,
    seasonLoading: Boolean(seasonSettingsLoading),
  });

  let body;
  if (!orgId) {
    body = <p className="text-sm text-text-muted">Select an organization to continue.</p>;
  } else if (outlook.status === 'loading') {
    body = (
      <p className="text-sm text-text-muted" role="status" data-testid="daylight-loading">
        Reading the season&rsquo;s practices…
      </p>
    );
  } else if (outlook.status === 'unreadable') {
    body = (
      <div data-testid="daylight-unreadable">
        <DataErrorBanner
          message={`The season's practices could not be read, so no outlook is shown: ${outlook.message}`}
        />
      </div>
    );
  } else if (outlook.status === 'no-season' || outlook.status === 'no-zone') {
    body = (
      <p className="text-sm" role="status" data-testid="daylight-blocked">
        {outlook.message}{' '}
        {outlook.status === 'no-zone' && (
          <Link to="/settings" className="text-link">
            Open Settings
          </Link>
        )}
      </p>
    );
  } else {
    body = <DaylightOutlook rows={outlook.rows} season={currentSeasonSetting} />;
  }

  return (
    <Page
      header={
        <PageHeader
          title="Practice daylight"
          subtitle="How the rest of the season would have to change for each evening practice to end by sunset. Proposed, not applied."
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-amber)' }}>
              <Sunset size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      {body}
    </Page>
  );
}
