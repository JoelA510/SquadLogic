import type { Page } from '@playwright/test';

const MOCK_CLIENT_TIMEOUT_MS = 15_000;

/**
 * Wait until the page's mock Supabase client has loaded.
 *
 * `frontend/src/lib/supabaseClient.js` loads `mockSupabaseClient.js` with a
 * dynamic import, so it is no longer part of the production main entry. The
 * page's load event does not wait for a dynamic import, so `page.goto()` can
 * return before the mock has run. Until then, `window.__saveMockDB__` is
 * undefined and `__MOCK_DB__` in sessionStorage has not been written.
 *
 * Call this before any `page.evaluate` that reads or writes the mock db.
 * It only waits; it asserts nothing about the app.
 */
export async function waitForMockClient(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => typeof window.__saveMockDB__ === 'function', undefined, {
      timeout: MOCK_CLIENT_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `Mock Supabase client did not load within ${MOCK_CLIENT_TIMEOUT_MS} ms on ${page.url()}: ` +
        'window.__saveMockDB__ is still not a function. Check that the dev server runs with ' +
        'VITE_USE_MOCK_SUPABASE=true and that lib/supabaseClient.js still loads the mock.',
      { cause: error }
    );
  }
}
