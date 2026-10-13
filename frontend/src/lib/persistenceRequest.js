/**
 * POST a persistence request to an Edge Function with a deadline (audit
 * finding 5.2, plan M2.5).
 *
 * The contract is `TeamPersistencePanel`'s: an `AbortController` is aborted at
 * the deadline, so a late response cannot land after the caller has moved on,
 * and the caller gets an error it can show. Two differences, each for a reason:
 *
 * - The deadline lives here, in the client, so every caller of the game and
 *   practice clients gets it; the team client takes its signal from the panel.
 * - 160 s, not the team panel's 10 s. Supabase answers an Edge Function that
 *   sends nothing for 150 s with a 504 (its request idle timeout), which the
 *   callers already report as an HTTP failure. A shorter deadline would call a
 *   slow save that is still committing a failure, and invite a second Apply;
 *   this one fires only when no answer, not even the platform's, can come: a
 *   lost connection or a stalled body.
 * - Its own race rather than `withTimeout`: that one cannot abort the request,
 *   and its error carries no `code` for a caller to tell a timeout apart by.
 *
 * An aborted request has still reached the server, which may have committed
 * it, so the timeout's message says the outcome is not known rather than
 * "nothing was saved".
 *
 * A 2xx whose body is not a JSON object is an error too: it used to read as
 * `{}`, an empty success. A non-2xx with an unreadable body still resolves
 * with `result: {}`, so each caller's own `HTTP <status>` message stands.
 */

/** Supabase's Edge request idle timeout (150 s, docs: functions/limits) plus 10 s. */
export const PERSISTENCE_TIMEOUT_MS = 160_000;

/** `code` of the error thrown when the deadline passes. */
export const PERSISTENCE_TIMEOUT = 'PERSISTENCE_TIMEOUT';

/** `code` of the error thrown for a 2xx whose body is not a JSON object. */
export const PERSISTENCE_UNREADABLE_RESPONSE = 'PERSISTENCE_UNREADABLE_RESPONSE';

function persistenceError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * @param {string} url
 * @param {Object} options
 * @param {string} options.token - the session's access token
 * @param {unknown} options.body - serialised with `JSON.stringify`
 * @param {string} options.label - what is being saved, for the messages ("The game schedule save")
 * @param {boolean} [options.bareMessages] - messages as a bare clause, for a caller that frames
 *   them itself (the enact panel: "It is not known whether the practice was enacted: <clause>.")
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ response: Response, result: Record<string, any> }>}
 */
export async function postPersistenceRequest(
  url,
  { token, body, label, bareMessages = false, timeoutMs = PERSISTENCE_TIMEOUT_MS }
) {
  const unknownOutcome = bareMessages
    ? ''
    : ', so it is not known whether the changes were saved. Check the saved schedule before ' +
      'applying again.';
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject first, then abort: the race settles on the timeout, never on
      // the AbortError the abort raises inside `fetch`.
      reject(
        persistenceError(
          `${label} did not answer within ${timeoutMs / 1000} seconds${unknownOutcome}`,
          PERSISTENCE_TIMEOUT,
          null
        )
      );
      controller.abort();
    }, timeoutMs);
  });

  const exchange = async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // The body is read under the same deadline: a stalled stream hangs as
    // surely as a stalled response.
    let parsed;
    let readable = true;
    try {
      parsed = await response.json();
    } catch (err) {
      // An abort is the deadline's, and the race has already settled on it.
      // Any other failure to read the body (not JSON, empty, cut off) is the
      // case handled below.
      if (controller.signal.aborted) throw err;
      readable = false;
    }
    const isObject =
      readable && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    if (response.ok && !isObject) {
      throw persistenceError(
        `${label} returned a response that could not be read (HTTP ${response.status})` +
          unknownOutcome,
        PERSISTENCE_UNREADABLE_RESPONSE,
        response.status
      );
    }
    return { response, result: isObject ? parsed : {} };
  };

  try {
    return await Promise.race([exchange(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
