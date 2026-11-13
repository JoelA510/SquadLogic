/**
 * What the schedule import clients share (the games import, `gameImportClient.js`, and the practice import,
 * `practiceImportClient.js`): how a refusal is thrown, the client check, a database error in its own words, and the
 * body of an Edge function's non-2xx answer. The counts each confirm compares are core's (`scheduleImport/previewCounts.js`
 * and `practiceImport/previewCounts.js`), not here.
 */

/**
 * An error that carries the code a refusal gave.
 *
 * @param {string} message
 * @param {string | null} [code]
 * @param {any} [body]
 */
export function refusal(message, code = null, body = null) {
  return Object.assign(new Error(message), { code, body });
}

/** @param {any} client */
export function requireClient(client) {
  if (typeof client?.rpc !== 'function' || typeof client?.from !== 'function') {
    throw new Error('there is no database connection to import with');
  }
}

/**
 * A database error in its own words, or in the words given for its detail code when its message is not written for a
 * person.
 *
 * @param {any} error
 * @param {string} fallback
 * @param {Record<string, string>} [words]  by `details` code
 */
export function rpcRefusal(error, fallback, words = {}) {
  return refusal(
    words[error?.details] || error?.message || fallback,
    error?.details || error?.code || null
  );
}

/**
 * The body of an Edge function's non-2xx answer (supabase-js puts the response on `context`), or null.
 *
 * @param {any} error
 */
export async function functionErrorBody(error) {
  if (typeof error?.context?.json !== 'function') return null;
  try {
    return await error.context.json();
  } catch {
    // Best effort: a body that is absent, already read or not JSON leaves the client's own message, which is shown.
    return null;
  }
}
