import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const triggerTeamPersistence = vi.fn();

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: { access_token: 'test-token' } }),
}));

vi.mock('../frontend/src/utils/teamPersistenceClient.js', () => ({
  getPersistenceEndpoint: () => 'https://example.invalid/team-persistence',
  triggerTeamPersistence: (...args) => triggerTeamPersistence(...args),
}));

const { default: TeamPersistencePanel } =
  await import('../frontend/src/components/TeamPersistencePanel.jsx');

const SYNC_BUTTON = /sync to supabase/i;

const makeSnapshot = (manualOverrides = []) => ({
  lastRunId: 'run-1',
  lastSyncedAt: null,
  preparedTeamRows: 2,
  preparedPlayerRows: 10,
  manualOverrides,
  runHistory: [],
  payload: { teamRows: [], teamPlayerRows: [] },
});

const renderPanel = (snapshot = makeSnapshot()) =>
  render(<TeamPersistencePanel teamPersistenceSnapshot={snapshot} />);

const statusRegion = () => screen.getByTestId('persistence-status');

const clickSync = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: SYNC_BUTTON }));
  });
};

/**
 * One scenario per `persistenceActionState` value TeamPersistencePanel can set. Each drives the
 * production path (real caller, mocked network client) to reach its state; none passes `status`
 * to PersistencePanel directly.
 */
const SCENARIOS = {
  idle: {
    label: 'System Ready',
    role: 'status',
    async reach() {
      renderPanel();
    },
  },
  submitting: {
    label: 'Syncing active...',
    role: 'status',
    async reach() {
      triggerTeamPersistence.mockReturnValue(new Promise(() => {}));
      renderPanel();
      await clickSync();
    },
  },
  ready: {
    label: 'Sync complete',
    role: 'status',
    detail: /Supabase upsert completed for 2 teams and 10 players/,
    async reach() {
      triggerTeamPersistence.mockResolvedValue({
        status: 'success',
        syncedAt: '2026-09-01T12:00:00Z',
        updatedTeams: 2,
        updatedPlayers: 10,
      });
      renderPanel();
      await clickSync();
    },
  },
  error: {
    label: 'Sync failed',
    role: 'alert',
    detail: 'Snapshot data unavailable',
    async reach() {
      triggerTeamPersistence.mockResolvedValue({
        status: 'error',
        message: 'Snapshot data unavailable',
      });
      renderPanel();
      await clickSync();
    },
  },
  blocked: {
    label: 'Sync blocked',
    role: 'status',
    detail: '1 manual override is still pending review.',
    async reach() {
      renderPanel(
        makeSnapshot([{ id: 'o-1', teamName: 'Team A', field: 'name', status: 'pending' }])
      );
    },
  },
};

// The universe is read from the caller's source, not from PersistencePanel's display map, so a
// state the caller can set but the panel (or this file) forgets fails here instead of passing.
const CALLER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../frontend/src/components/TeamPersistencePanel.jsx'),
  'utf8'
);
const CALLER_STATES = [
  ...new Set(
    [...CALLER_SOURCE.matchAll(/setPersistenceActionState\('([a-z]+)'\)/g)].map((m) => m[1])
  ),
].sort();

beforeEach(() => {
  triggerTeamPersistence.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PersistencePanel status display (via TeamPersistencePanel)', () => {
  it('has a scenario for every state the caller can set', () => {
    // Meta-assertion: the extraction must have found the caller's states.
    expect(CALLER_STATES.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(SCENARIOS).sort()).toEqual(CALLER_STATES);
  });

  it.each(CALLER_STATES)('state %s renders its own label and live-region role', async (state) => {
    const scenario = SCENARIOS[state];
    expect(scenario, `no scenario for caller state "${state}"`).toBeDefined();
    await scenario.reach();

    const region = statusRegion();
    expect(within(region).getByText(scenario.label)).toBeVisible();
    if (state !== 'idle') {
      expect(within(region).queryByText('System Ready')).toBeNull();
    }
    if (scenario.detail) {
      expect(within(region).getByText(scenario.detail)).toBeVisible();
    }

    // The row sits inside the live region matching its state; the other region is empty.
    const liveRegion = region.parentElement;
    expect(liveRegion).toHaveAttribute('role', scenario.role);
    expect(liveRegion).toHaveAttribute(
      'aria-live',
      scenario.role === 'alert' ? 'assertive' : 'polite'
    );
    const otherRole = scenario.role === 'alert' ? 'status' : 'alert';
    expect(screen.getByRole(otherRole)).toBeEmptyDOMElement();
  });

  it('keeps both live regions mounted across state changes so updates are announced', async () => {
    triggerTeamPersistence.mockReturnValue(new Promise(() => {}));
    renderPanel();
    const polite = screen.getByRole('status');
    const assertive = screen.getByRole('alert');
    await clickSync();
    expect(screen.getByRole('status')).toBe(polite);
    expect(screen.getByRole('alert')).toBe(assertive);
    expect(within(polite).getByText('Syncing active...')).toBeVisible();
  });

  it('an endpoint "blocked" result keeps its own message instead of resetting to idle', async () => {
    triggerTeamPersistence.mockResolvedValue({
      status: 'blocked',
      message: 'Server has 2 pending overrides.',
    });
    renderPanel();
    await clickSync();

    const status = screen.getByRole('status');
    expect(within(status).getByText('Sync blocked')).toBeVisible();
    expect(within(status).getByText('Server has 2 pending overrides.')).toBeVisible();
    expect(screen.queryByText('All manual overrides have been reviewed.')).toBeNull();
  });

  it('an unexpected result status is a failure, not a success', async () => {
    triggerTeamPersistence.mockResolvedValue({
      status: 'queued',
      message: 'Unexpected response from persistence endpoint.',
    });
    renderPanel();
    await clickSync();

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Sync failed')).toBeVisible();
    expect(within(alert).getByText('Unexpected response from persistence endpoint.')).toBeVisible();
    expect(screen.queryByText('Sync complete')).toBeNull();
  });

  it('announces politely when reviewing the last pending override clears the block', async () => {
    renderPanel(
      makeSnapshot([{ id: 'o-1', teamName: 'Team A', field: 'name', status: 'pending' }])
    );
    expect(within(screen.getByRole('status')).getByText('Sync blocked')).toBeVisible();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /mark.*(reviewed|applied)/i }));
    });

    const status = screen.getByRole('status');
    expect(within(status).getByText('System Ready')).toBeVisible();
    expect(within(status).getByText('All manual overrides have been reviewed.')).toBeVisible();
  });

  it('a thrown sync error renders as a failure alert', async () => {
    triggerTeamPersistence.mockRejectedValue(new Error('network down'));
    renderPanel();
    await clickSync();

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Sync failed')).toBeVisible();
    expect(within(alert).getByText('Supabase sync failed. Please retry.')).toBeVisible();
  });

  it('a client-side timeout stays a visible failure instead of resetting to idle', async () => {
    vi.useFakeTimers();
    triggerTeamPersistence.mockReturnValue(new Promise(() => {}));
    renderPanel();
    await clickSync();
    expect(within(statusRegion()).getByText('Syncing active...')).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Sync failed')).toBeVisible();
    expect(within(alert).getByText('Supabase sync timed out. Please retry.')).toBeVisible();
    expect(screen.queryByText('All manual overrides have been reviewed.')).toBeNull();
    expect(triggerTeamPersistence.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('a timed-out request that resolves late cannot overwrite a retry', async () => {
    vi.useFakeTimers();
    let resolveFirst;
    triggerTeamPersistence
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise(() => {}));
    renderPanel();
    await clickSync();
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    await clickSync();
    expect(within(screen.getByRole('status')).getByText('Syncing active...')).toBeVisible();

    await act(async () => {
      resolveFirst({ status: 'success', syncedAt: '2026-09-01T12:00:00Z', updatedTeams: 2 });
    });
    expect(within(screen.getByRole('status')).getByText('Syncing active...')).toBeVisible();

    // The retry's own timeout was not cleared by the stale request's `finally`.
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(within(screen.getByRole('alert')).getByText('Sync failed')).toBeVisible();
  });

  it('only animates the indicator while a sync is in flight', async () => {
    renderPanel();
    expect(document.body.querySelector('.animate-ping')).toBeNull();

    cleanup();
    triggerTeamPersistence.mockReturnValue(new Promise(() => {}));
    renderPanel();
    await clickSync();
    expect(document.body.querySelector('.animate-ping')).not.toBeNull();
  });
});
