/**
 * Whether a failed read was cancelled rather than refused.
 *
 * Three shapes reach a caller, and `err.name === 'AbortError'` alone sees only the first:
 *
 * 1. A thrown `DOMException` named `AbortError` (or a Node-style error with `code: 'ABORT_ERR'`),
 *    from `fetch` or from code that rejects the way `fetch` does.
 * 2. supabase-js's PostgREST builder, which does not throw: it resolves `{ error }` with a plain
 *    object whose `message` is `"AbortError: <the fetch error's message>"` and whose `hint` is
 *    `"Request was aborted (timeout or manual cancellation)"`, and no `name` of its own. Read
 *    from the installed `@supabase/postgrest-js` 2.117.3 (`dist/index.mjs`, `PostgrestBuilder`'s
 *    `then`): the message is built from the fetch error's `name`, so an abort whose error is not
 *    named `AbortError` (`code: 'ABORT_ERR'`) is recognisable only by the hint.
 * 3. Any error at all once the caller's own signal is aborted: whatever the read reports after
 *    its owner cancelled it describes nothing the owner still waits for.
 *
 * @param {unknown} err
 * @param {AbortSignal | null | undefined} [signal] - the signal the caller passed to the read.
 * @returns {boolean}
 */
export function isAbortError(err, signal = undefined) {
  if (signal?.aborted) return true;
  if (!err || typeof err !== 'object') return false;
  const { name, code, message, hint } = /** @type {Record<string, unknown>} */ (err);
  if (name === 'AbortError' || code === 'ABORT_ERR') return true;
  if (typeof message === 'string' && message.startsWith('AbortError:')) return true;
  return typeof hint === 'string' && hint.startsWith('Request was aborted');
}
