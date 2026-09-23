/**
 * #51: `schoolDayEnd` is not sent to the auto-scheduler Edge Function.
 *
 * The function has no code for it (`supabase/functions/auto-scheduler/index.ts`
 * never reads it), so sending it made the UI present as meaningful a field
 * nothing honoured. Core still honours it, and the page still hands it to core
 * via `buildPracticeRunResults` -- the second half of this file pins that the
 * removal did not reach the honouring path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderHook, act } from '@testing-library/react';

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
      channel: () => channel,
      removeChannel: () => {},
    },
  };
});

const { useAutoScheduler } = await import('../frontend/src/hooks/useAutoScheduler.js');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the auto-scheduler request body (#51)', () => {
  it('does not carry schoolDayEnd, even when a caller still passes it', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ assignments: [], unassigned: [], evaluation: {}, optimization: {} }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useAutoScheduler({ organizationId: '11111111-1111-4111-8111-111111111111' })
    );
    await act(async () => {
      await result.current.trigger({
        teams: [{ id: 't-51', division: 'U10' }],
        slots: [{ id: 's-51', start: 'a', end: 'b', capacity: 1 }],
        schoolDayEnd: '16:00',
        seasonSettingsId: '22222222-2222-4222-8222-222222222222',
      });
    });

    // Meta-assertion: the request was actually made, so the check below read a
    // real body rather than passing over nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = /** @type {any[]} */ (fetchMock.mock.calls[0]);
    expect(url).toMatch(/\/auto-scheduler$/);
    const body = JSON.parse(init.body);
    // Control: a key passed alongside it does arrive, so `toHaveProperty` can
    // see what the hook forwards.
    expect(body).toHaveProperty('seasonSettingsId', '22222222-2222-4222-8222-222222222222');
    expect(body).not.toHaveProperty('schoolDayEnd');
    expect(JSON.stringify(body)).not.toContain('16:00');
  });

  it('the page no longer passes it to the trigger, but still hands it to core', () => {
    const page = readFileSync(
      path.join(process.cwd(), 'frontend/src/pages/PracticeSchedulingPage.jsx'),
      'utf8'
    );
    const callOf = (marker) => {
      const start = page.indexOf(marker);
      expect(start, `${marker} not found`).toBeGreaterThan(-1);
      return page.slice(start, page.indexOf('});', start));
    };
    const trigger = callOf('autoScheduler.trigger({');
    expect(trigger).toContain('slots: schedulerSlots');
    expect(trigger).not.toMatch(/schoolDayEnd/);
    // The honouring path: core `evaluatePracticeSchedule` via
    // `buildPracticeRunResults` still receives the season's value.
    const results = callOf('buildPracticeRunResults({');
    expect(results).toMatch(/^\s*schoolDayEnd,\s*$/m);
  });
});
