import React from 'react';
import { Lightbulb } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { usePermission } from '../hooks/usePermission.js';
import AdminLightingQueue from '../components/lighting/AdminLightingQueue.jsx';
import CoachLightingRequests from '../components/lighting/CoachLightingRequests.jsx';

/**
 * Portable-lighting overrides (8.9 D14 PR D), gated like
 * `CoachPreferencesPage`: an admin (`DECIDE_PRACTICE_LIGHTING_OVERRIDE`) gets
 * the approval queue; anyone else who reaches the route (a coach, via
 * `REQUEST_PRACTICE_LIGHTING_OVERRIDE`) gets their own request view and no
 * decision controls. The RPCs refuse a non-admin decision regardless.
 */
export default function PracticeLightingPage() {
  const { currentOrganization } = useOrganization();
  const { user } = useAuth();
  const { can, PERMISSIONS } = usePermission();
  const toast = useToast();
  const orgId = currentOrganization?.id ? String(currentOrganization.id) : null;
  const userId = String(user?.id ?? '');
  const isAdmin = can(PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE);

  return (
    <Page
      header={
        <PageHeader
          title="Practice lighting"
          subtitle={
            isAdmin
              ? 'Decide requests for portable lighting on practice slots, or set one directly.'
              : 'Ask for portable lighting on a practice slot you coach. An admin decides.'
          }
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-amber)' }}>
              <Lightbulb size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      {!orgId ? (
        <p className="text-sm text-text-muted">Select an organization to continue.</p>
      ) : isAdmin ? (
        <AdminLightingQueue orgId={orgId} userId={userId} toast={toast} />
      ) : (
        <CoachLightingRequests orgId={orgId} userId={userId} toast={toast} />
      )}
    </Page>
  );
}
