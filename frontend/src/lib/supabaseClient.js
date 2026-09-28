/// <reference types="vite/client" />
/**
 * Supabase Client — Environment-Aware Switcher
 *
 * Exports a single `supabase` client that is either:
 *   - A real @supabase/supabase-js client (when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set)
 *   - A sessionStorage-backed mock client (for E2E tests and local dev without a backend)
 *
 * All consumers import `{ supabase }` from this module — the switch is transparent.
 *
 * **The mock is loaded with a dynamic import, never a static one.** A static
 * import put all of `mockSupabaseClient.js` in the production main entry. In
 * mock mode `supabase` is a live binding that is assigned when the mock has
 * loaded, and `supabaseReady` settles then; `main.jsx` renders the app only
 * after `supabaseReady`, so no component or effect sees it unassigned. No
 * importer reads `supabase` while its module is evaluating (every read is
 * inside a function), which is what makes the late assignment safe.
 *
 * Not a top-level `await`: the mock chunk imports shared modules back from the
 * main entry chunk, so awaiting it there deadlocks the built app in mock mode,
 * and Rollup splits a new first-paint chunk out of the entry for it.
 * `tests/mockNotInMainBundle.test.js` guards all of this.
 */
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_MOCK_MODE } from '../config.js';
import { logger } from './logger.js';

/**
 * Build-time check: can this build ever run the mock? Vite replaces each
 * `import.meta.env.*` below with a literal. In a production build with both
 * credentials and without `VITE_USE_MOCK_SUPABASE=true`, this is `false`, and
 * Rollup drops the dynamic import, so the mock chunk is not emitted at all.
 * `config.js` reads the same variables, so in a browser `IS_MOCK_MODE` cannot
 * be `true` while this is `false`; if the two ever disagree, `supabaseReady`
 * rejects rather than letting the app run without a client.
 */
const MOCK_CAPABLE_BUILD =
  !import.meta.env.PROD ||
  import.meta.env.VITE_USE_MOCK_SUPABASE === 'true' ||
  !import.meta.env.VITE_SUPABASE_URL ||
  !import.meta.env.VITE_SUPABASE_ANON_KEY;

if (IS_MOCK_MODE) {
  logger.log('[Supabase] Initializing MOCK client');
  logger.warn('[Supabase] Mock client active');
} else {
  logger.log('[Supabase] Initializing REAL client', SUPABASE_URL);
}

/**
 * The Supabase client instance — real or mock depending on environment.
 * In mock mode it is assigned once the mock has loaded; see `supabaseReady`.
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
export let supabase = IS_MOCK_MODE ? undefined : createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Settles once `supabase` is assigned: immediately for the real client, after
 * the mock chunk has loaded in mock mode.
 * @type {Promise<void>}
 */
export const supabaseReady = IS_MOCK_MODE ? loadMockClient() : Promise.resolve();

async function loadMockClient() {
  if (!MOCK_CAPABLE_BUILD) {
    throw new Error('[Supabase] Mock mode is active, but this build does not include the mock.');
  }
  const { mockSupabase } = await import('./mockSupabaseClient.js');
  supabase = /** @type {any} */ (mockSupabase);
}
