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
    role: null,
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

    if (scenario.role) {
      expect(region).toHaveAttribute('role', scenario.role);
      expect(region).toHaveAttribute(
        'aria-live',
        scenario.role === 'alert' ? 'assertive' : 'polite'
      );
    } else {
      expect(region).not.toHaveAttribute('role');
      expect(region).not.toHaveAttribute('aria-live');
    }
    // Failure is the only state that interrupts.
    expect(screen.queryAllByRole('alert')).toHaveLength(state === 'error' ? 1 : 0);
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
