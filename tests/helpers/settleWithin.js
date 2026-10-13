import { vi } from 'vitest';

/**
 * Advance fake time in steps of at most 1 s until `promise` settles, for at most
 * `limitMs`. Resolves `true` when it settled, `false` when it is still
 * pending: a call that hangs fails the caller's assertion instead of hanging
 * the test. Needs `vi.useFakeTimers()`.
 *
 * Stepping (rather than one jump) lets the awaits before a request is sent
 * (a session read, a snapshot build) run before the deadline timer exists.
 *
 * @param {Promise<unknown>} promise
 * @param {number} limitMs
 * @returns {Promise<boolean>}
 */
export async function settleWithin(promise, limitMs) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  for (let waited = 0; !settled && waited < limitMs; ) {
    const step = Math.min(1000, limitMs - waited);
    await vi.advanceTimersByTimeAsync(step);
    waited += step;
  }
  return settled;
}
