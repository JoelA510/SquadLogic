import { describe, expect, it, vi } from 'vitest';
import {
  buildSetupTelemetryRpcParams,
  logSetupWizardTelemetry,
} from '../frontend/src/utils/setupTelemetry.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

describe('setup telemetry', () => {
  it('builds org-scoped RPC params and protects explicit telemetry fields', () => {
    expect(
      buildSetupTelemetryRpcParams({
        organizationId: MOCK_ORG_ID,
        eventType: 'wizard.step_completed',
        sessionId: 'session-1',
        step: 2,
        payload: {
          session_id: 'payload-session',
          step: 99,
          custom: true,
        },
      })
    ).toEqual({
      p_org_id: MOCK_ORG_ID,
      p_event_name: 'wizard.step_completed',
      p_payload: {
        custom: true,
        session_id: 'session-1',
        step: 2,
      },
    });
  });

  it('uses the existing telemetry RPC and does not call it without an org id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'telemetry-id', error: null });
    const logger = { error: vi.fn() };

    await logSetupWizardTelemetry({
      supabaseClient: { rpc },
      organizationId: MOCK_ORG_ID,
      eventType: 'wizard.finalized',
      sessionId: undefined,
      payload: { final_flags: { imports: true } },
      step: 3,
      logger,
    });

    expect(rpc).toHaveBeenCalledWith('log_telemetry_event', {
      p_org_id: MOCK_ORG_ID,
      p_event_name: 'wizard.finalized',
      p_payload: {
        final_flags: { imports: true },
        session_id: 'N/A',
        step: 3,
      },
    });
    expect(logger.error).not.toHaveBeenCalled();

    await logSetupWizardTelemetry({
      supabaseClient: { rpc },
      organizationId: null,
      eventType: 'wizard.finalized',
      sessionId: undefined,
      step: 3,
      logger,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('logs telemetry failures without throwing', async () => {
    const error = new Error('rpc failed');
    const rpc = vi.fn().mockResolvedValue({ data: null, error });
    const logger = { error: vi.fn() };

    await expect(
      logSetupWizardTelemetry({
        supabaseClient: { rpc },
        organizationId: MOCK_ORG_ID,
        eventType: 'wizard.finalized',
        sessionId: 'session-1',
        step: 3,
        logger,
      })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('Telemetry failed', error);
  });
});
