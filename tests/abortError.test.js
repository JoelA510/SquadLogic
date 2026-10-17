/**
 * `isAbortError`, and `useSchedulerRun` ignoring a read it cancelled itself
 * (Wave 3, remediation plan, "Discovered during execution", 2026-10-14).
 *
 * The hook ignored an abort by `err.name === 'AbortError'`, but supabase-js
 * does not throw a cancelled read: it resolves `{ error }` with an object that
 * has no `name`, so the cancellation became the hook's error. On the dev server
 * (StrictMode runs each effect twice, cancelling the first read) the Exports page
 * then refused to build CSVs.
 *
 * The abort shape here is never written by hand: it is what the installed
 * `@supabase/supabase-js` returns, through its real PostgREST builder, for a
 * fetch that rejects the way `fetch` does when its signal is aborted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createClient } from '@supabase/supabase-js';
import { isAbortError } from '../frontend/src/lib/abortError.js';

const state = vi.hoisted(() => ({
  /** @type {any} */ client: null,
  /** How many `scheduler_runs` reads hang until aborted before the reads answer. */
  hangingReads: 0,
  /** How many hanging reads were aborted. */
  aborted: 0,
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: (table) => state.client.from(table) },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '0f5e2c4a-8b1d-4e6f-9a3c-2d7b8e9f0a01' },
    currentSeasonSetting: { id: '0f5e2c4a-8b1d-4e6f-9a3c-2d7b8e9f0a02' },
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));

const { useSchedulerRun } = await import('../frontend/src/hooks/useSchedulerRun.js');

const RUN = { id: 'game-run-1', results: {}, completed_at: '2026-10-01T00:00:00Z' };

/**
 * A `fetch` as the browser's behaves for these reads: a hanging one rejects with
 * an `AbortError` `DOMException` when its signal is aborted; the others answer.
 */
function fakeFetch(url, init) {
  const isRunRead = String(url).includes('/scheduler_runs');
  if (isRunRead && state.hangingReads > 0) {
    state.hangingReads -= 1;
    return new Promise((_resolve, reject) => {
      const abort = () => {
        state.aborted += 1;
        reject(new DOMException('signal is aborted without reason', 'AbortError'));
      };
      // supabase-js calls `fetch` after an await of its own, so the signal can be aborted
      // already, and `fetch` then rejects at once.
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort);
    });
  }
  const body = isRunRead ? RUN : null;
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function makeClient() {
  return createClient('https://example.invalid', 'anon-key-for-tests', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fakeFetch },
  });
}

/** What the installed supabase-js resolves for a read whose signal is aborted. */
async function realCancelledReadError() {
  state.hangingReads = 1;
  const controller = new AbortController();
  const pending = state.client
    .from('scheduler_runs')
    .select('*')
    .limit(1)
    .maybeSingle()
    .abortSignal(controller.signal);
  controller.abort();
  const { error } = await pending;
  return error;
}

describe('isAbortError', () => {
  beforeEach(() => {
    state.client = makeClient();
    state.hangingReads = 0;
    state.aborted = 0;
  });

  it("recognises supabase-js's cancelled read, which has no name", async () => {
    const error = await realCancelledReadError();
    // Meta-assertion: this is the shape the old check missed, from the library itself.
    expect(error).toBeTruthy();
    expect(error.name).not.toBe('AbortError');
    expect(error.message).toMatch(/^AbortError:/);

    expect(isAbortError(error)).toBe(true);
  });

  it('recognises an abort by its hint when the fetch error is not named AbortError', () => {
    // postgrest-js 2.117.3 sets this hint for `code: 'ABORT_ERR'` too, whose message then
    // starts with that error's own name.
    expect(
      isAbortError({
        message: 'Error: The operation was aborted',
        details: '',
        hint: 'Request was aborted (timeout or manual cancellation)',
        code: '',
      })
    ).toBe(true);
  });

  it('recognises a thrown AbortError and an ABORT_ERR code', () => {
    expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('stop'), { code: 'ABORT_ERR' }))).toBe(true);
  });

  it('treats anything as cancelled once the caller aborted its own signal', () => {
    const controller = new AbortController();
    const refused = { message: 'permission denied for table scheduler_runs', code: '42501' };
    expect(isAbortError(refused, controller.signal)).toBe(false);
    controller.abort();
    expect(isAbortError(refused, controller.signal)).toBe(true);
  });

  it('does not take a refusal, a network failure or nothing for an abort', () => {
    expect(
      isAbortError({
        message: 'permission denied for table scheduler_runs',
        details: null,
        hint: null,
        code: '42501',
      })
    ).toBe(false);
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined, undefined)).toBe(false);
  });
});

describe('useSchedulerRun :: a read it cancelled is not its error', () => {
  beforeEach(() => {
    state.client = makeClient();
    state.hangingReads = 0;
    state.aborted = 0;
  });

  it('a re-read that cancels the one in flight leaves no error, and shows the run', async () => {
    // The first read hangs, as a read StrictMode's second effect cancels does.
    state.hangingReads = 1;
    const mapper = vi.fn((run) => ({ runId: run.id }));
    const { result } = renderHook(() => useSchedulerRun('game', mapper, { runId: null }));
    expect(result.current.loading).toBe(true);

    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data).toEqual({ runId: RUN.id }));
    // Let the cancelled read's rejection settle, then check nothing it said stuck.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ runId: RUN.id });
    expect(result.current.loading).toBe(false);
    // Meta-assertion: the first read really was cancelled (it hung until aborted).
    expect(state.aborted).toBe(1);
  });
});
