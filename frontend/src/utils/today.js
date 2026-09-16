/**
 * Today, as `YYYY-MM-DD`.
 *
 * **One producer, and it deliberately matches the mock's.**
 * `mockSupabaseClient.js` answers the same question with
 * `new Date().toISOString().slice(0, 10)` (its `todayIso`, and the reading its
 * retirement trigger uses), so a page computing "today" any other way would
 * disagree with the client it is talking to in E2E and mock mode.
 *
 * **The seam this crosses, named rather than hidden.** This is the UTC date.
 * Postgres's `current_date` — which `public.field_is_live_on` falls back to —
 * is the server's date. For a club in America/Los_Angeles the two differ for
 * the last 7–8 hours of each local day, so a field retired "yesterday" can read
 * as live for one more evening on the client while the database has already
 * moved on. It is the pre-existing reading throughout the frontend and is not
 * changed here; a real fix is a season timezone on the organisation, which
 * belongs with 8.5's materialisation rather than with a CRUD screen.
 *
 * `packages/core` constructs no `Date` at all. This file is the frontend side
 * of that boundary: the one place a `Date` is made to answer "what day is it",
 * so every core call downstream receives a plain `YYYY-MM-DD` string.
 *
 * @returns {string} `YYYY-MM-DD`
 */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
