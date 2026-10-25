import React from 'react';
import { Lightbulb } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import AdminLightingQueue from '../components/lighting/AdminLightingQueue.jsx';

/**
 * Portable-lighting overrides (8.9 D14 PR D), an admin page: the approval
 * queue for rows requested before 20261028010000, and a direct set. Lighting
 * is admin-only with no coach requests since then (plan
 * docs/changes/2026-10-22-admin-focus.md, R6, owner decision 4), so the route
 * admits `DECIDE_PRACTICE_LIGHTING_OVERRIDE` only, and the RPCs refuse a
 * non-admin regardless.
 */
export default function PracticeLightingPage() {
  const { currentOrganization } = useOrganization();
  const { user } = useAuth();
  const toast = useToast();
  const orgId = currentOrganization?.id ? String(currentOrganization.id) : null;
  const userId = String(user?.id ?? '');

  return (
    <Page
      header={
        <PageHeader
          title="Practice lighting"
          subtitle="Decide requests for portable lighting on practice slots, or set one directly."
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
      ) : (
        <AdminLightingQueue orgId={orgId} userId={userId} toast={toast} />
      )}
    </Page>
  );
}
