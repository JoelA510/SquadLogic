import React from 'react';
import { SlidersHorizontal } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import AdminPreferenceReview from '../components/preferences/AdminPreferenceReview.jsx';

/**
 * Coach practice preferences (Phase 8.6 PR 3b, PR 2), the admins' review. Coaches never sign in
 * (docs/changes/2026-10-27-admin-only.md), so there is no request view: an admin reviews the
 * requests on file and sets a preference on a coach's behalf. The route needs
 * `DECIDE_PRACTICE_PREFERENCE`, and the RPCs refuse a non-admin regardless of what renders.
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
          subtitle="Review coach requests to keep a practice weekday, start time or venue."
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
