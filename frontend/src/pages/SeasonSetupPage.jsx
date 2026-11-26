import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Sparkles } from 'lucide-react';
import SetupChecklist from '../components/setup/SetupChecklist.jsx';
import Button from '../components/ui/Button.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logSetupWizardTelemetry } from '../utils/setupTelemetry.js';
import { logger } from '../lib/logger.js';

/**
 * Season Setup — the resumable checklist that replaced the progress-wiping
 * wizard. Completion state is derived from live data; "Mark setup complete"
 * (or skipping) finalizes onboarding via the audited finalize_onboarding
 * RPC, preserving the wizard's telemetry event names.
 */
export default function SeasonSetupPage() {
  const navigate = useNavigate();
  const { currentOrganization, featureFlags = {} } = useOrganization();
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState(null);

  const finalize = async (skipped) => {
    if (!currentOrganization?.id) return;
    setFinishing(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('finalize_onboarding', {
        p_org_id: currentOrganization.id,
        p_flags: featureFlags,
      });
      if (rpcError) throw rpcError;
      await logSetupWizardTelemetry({
        supabaseClient: supabase,
        organizationId: currentOrganization.id,
        eventType: 'wizard.finalized',
        sessionId: null,
        payload: { final_flags: featureFlags, skipped },
        step: null,
        logger,
      });
      // Full reload so the org's is_onboarded state is re-fetched everywhere.
      window.location.href = '/?onboarded=true';
    } catch (err) {
      logger.error('[SeasonSetup] finalize failed:', err);
      setError(err.message || 'Could not complete setup. Please try again.');
      setFinishing(false);
    }
  };

  const isOnboarded = !!currentOrganization?.is_onboarded;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-app)', overflow: 'auto' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '32px 24px 64px' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 18,
          }}
        >
          <span className="page-obj-icon" style={{ background: 'var(--primary)' }}>
            <Sparkles size={20} aria-hidden="true" />
          </span>
          <div style={{ flex: 1 }}>
            <h1 className="page-title">Season Setup</h1>
            <div className="page-sub">
              <strong>{currentOrganization?.name}</strong> · Each step is also available in the
              navigation.
            </div>
          </div>
          {isOnboarded && (
            <Button variant="secondary" onClick={() => navigate('/')}>
              Back to Home
            </Button>
          )}
        </header>

        {error && (
          <div className="badge danger" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}

        <SetupChecklist />

        {!isOnboarded && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 22,
              justifyContent: 'flex-end',
            }}
          >
            <Button variant="ghost" disabled={finishing} onClick={() => finalize(true)}>
              Skip for now
            </Button>
            <Button
              variant="primary"
              icon={CheckCircle2}
              loading={finishing}
              onClick={() => finalize(false)}
            >
              Mark setup complete
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
