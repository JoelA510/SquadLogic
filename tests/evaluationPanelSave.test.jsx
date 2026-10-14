/**
 * EvaluationPanel's "Sync to Audit" Save is under the persistence deadline
 * (found by PR 2-C, plan "Discovered during execution": the Save had none, so
 * "Hardening results..." could spin forever).
 *
 * The deadline is `lib/persistenceRequest.js`'s (M2.5), not `invoke`'s own
 * `timeout`, whose abort surfaces as "Failed to send a request": wrong for a
 * request that was sent. And since the save may still land after the panel
 * stops waiting, the cached evaluation reads are dropped then too, as after a
 * save that answered.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import EvaluationPanel from '../frontend/src/components/EvaluationPanel.jsx';
import { edgeFunctionCache } from '../frontend/src/lib/cache.js';
import { PERSISTENCE_TIMEOUT_MS } from '../frontend/src/lib/persistenceRequest.js';

const ORG = '00000000-0000-4000-8000-0000000000c3';

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: '00000000-0000-4000-8000-0000000000c3' } }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: null }));

const PRACTICE = {
  assignments: [{ teamId: 'team-1', slotId: 'slot-1' }],
  teams: [{ id: 'team-1', division: 'U10' }],
  slots: [{ id: 'slot-1', capacity: 1 }],
};

const EVALUATION = { status: 'ok', metrics: { combinedScore: 0.9 }, issues: [] };

/**
 * A client whose reads answer at once and whose save is `save`; every save
 * call's options are kept so the test can read the signal it was given.
 */
function clientWith(save) {
  const saves = [];
  const invoke = vi.fn((name, options) => {
    if (options?.body?.persist === true) {
      saves.push(options);
      return save(options);
    }
    return Promise.resolve({ data: EVALUATION, error: null });
  });
  return { client: { functions: { invoke } }, saves };
}

async function renderEvaluated(client) {
  render(<EvaluationPanel practiceData={PRACTICE} supabaseClient={/** @type {any} */ (client)} />);
  const button = await screen.findByRole('button', { name: /sync to audit/i }, { timeout: 3000 });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  edgeFunctionCache.clear();
});

describe('EvaluationPanel :: Save under the persistence deadline', () => {
  it('a save that never answers ends at the deadline, says the outcome is unknown, and re-enables', async () => {
    const { client, saves } = clientWith(() => new Promise(() => {}));
    const button = await renderEvaluated(client);
    const invalidate = vi.spyOn(edgeFunctionCache, 'invalidateByPrefix');

    vi.useFakeTimers();
    fireEvent.click(button);
    expect(screen.getByText('Hardening results in audit trail...')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERSISTENCE_TIMEOUT_MS - 1000);
    });
    expect(screen.getByText('Hardening results in audit trail...')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(
      screen.getByText(
        `It is not known whether the evaluation was saved: the save did not answer within ${
          PERSISTENCE_TIMEOUT_MS / 1000
        } seconds. Check the audit trail before saving it again.`
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync to audit/i })).toBeEnabled();
    // One request, aborted at the deadline, and nothing about "Failed to send".
    expect(saves).toHaveLength(1);
    expect(saves[0].signal?.aborted).toBe(true);
    expect(screen.queryByText(/failed to send/i)).toBeNull();
    // The save may have landed: the cached reads are the server's to answer again.
    expect(invalidate).toHaveBeenCalledWith(`fairness-scoring:${ORG}:`);
  });

  it('a refused save says why, in the function own words', async () => {
    const context = { json: async () => ({ error: 'A game evaluation needs at least one team' }) };
    const { client } = clientWith(() =>
      Promise.resolve({ data: null, error: Object.assign(new Error('non-2xx'), { context }) })
    );
    const button = await renderEvaluated(client);
    const invalidate = vi.spyOn(edgeFunctionCache, 'invalidateByPrefix');

    fireEvent.click(button);
    expect(
      await screen.findByText('Save sync failed: A game evaluation needs at least one team')
    ).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a save that answers invalidates the cached reads and says so', async () => {
    const { client } = clientWith(() => Promise.resolve({ data: { runId: 'r' }, error: null }));
    const button = await renderEvaluated(client);
    const invalidate = vi.spyOn(edgeFunctionCache, 'invalidateByPrefix');

    fireEvent.click(button);
    expect(
      await screen.findByText('A-1 Audit: Evaluation persisted successfully.')
    ).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith(`fairness-scoring:${ORG}:`);
  });
});
