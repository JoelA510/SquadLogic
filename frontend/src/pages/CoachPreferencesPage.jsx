import React from 'react';
import { SlidersHorizontal } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { usePermission } from '../hooks/usePermission.js';
import AdminPreferenceReview from '../components/preferences/AdminPreferenceReview.jsx';
import CoachPreferenceRequests from '../components/preferences/CoachPreferenceRequests.jsx';

/**
 * Coach practice preferences (Phase 8.6 PR 3b, PR 2). Operator ruling: coaches
 * request, only admins change. An admin (`DECIDE_PRACTICE_PREFERENCE`) gets the
 * review view; anyone else who reaches the route (a coach, via
 * `REQUEST_PRACTICE_PREFERENCE`) gets their own request view and no decision
 * controls. The RPCs refuse a non-admin decision regardless of what renders.
 */
export default function CoachPreferencesPage() {
  const { currentOrganization } = useOrganization();
  const { user } = useAuth();
  const { can, PERMISSIONS } = usePermission();
  const toast = useToast();
  const orgId = currentOrganization?.id ? String(currentOrganization.id) : null;
  const isAdmin = can(PERMISSIONS.DECIDE_PRACTICE_PREFERENCE);

  return (
    <Page
      header={
        <PageHeader
          title="Practice preferences"
          subtitle={
            isAdmin
              ? 'Review coach requests to keep a practice weekday, start time or venue.'
              : 'Ask to keep your practice weekday, start time or venue. An admin decides.'
          }
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
      ) : isAdmin ? (
        <AdminPreferenceReview orgId={orgId} toast={toast} />
      ) : (
        <CoachPreferenceRequests orgId={orgId} userId={String(user?.id ?? '')} toast={toast} />
      )}
    </Page>
  );
}
