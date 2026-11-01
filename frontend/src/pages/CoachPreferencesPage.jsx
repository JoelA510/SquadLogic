import React from 'react';
import { SlidersHorizontal } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import AdminPreferenceReview from '../components/preferences/AdminPreferenceReview.jsx';

/**
 * Practice preference rules (Phase D C1; originally Phase 8.6 PR 3b, PR 2), the admins' review.
 * Coaches never sign in (docs/changes/2026-10-27-admin-only.md), so there is no request view: a
 * preference file is imported by an admin (the import screen is Phase D C2), and an admin accepts the
 * musts it asked for and adds or removes rules here. The route needs `DECIDE_PRACTICE_PREFERENCE`,
 * and the RPCs refuse a non-admin regardless of what renders.
 */
export default function CoachPreferencesPage() {
  const { currentOrganization } = useOrganization();
  const toast = useToast();
  const orgId = currentOrganization?.id ? String(currentOrganization.id) : null;

  return (
    <Page
      header={
        <PageHeader
          title="Practice preferences"
          subtitle="Rules for the days, start times and venues a team practises on, and the musts waiting for your decision."
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-teal)' }}>
              <SlidersHorizontal size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      {!orgId ? (
        <p className="text-sm text-text-muted">Select an organization to continue.</p>
      ) : (
        <AdminPreferenceReview orgId={orgId} toast={toast} />
      )}
    </Page>
  );
}
