/**
 * The mock-mode guard fails closed (plan item M1.7, audit finding 5.1). It was
 * in frontend/src/config.js; M2.2 moved it unchanged into frontend/src/env.js,
 * which config.js re-exports, so these cases still load config.js. Since M2.2
 * a production build without the variables fails at build time
 * (tests/env.test.js); this guard is the second line.
 *
 * The guard used to exempt `localhost`, `127.0.0.1` and every `*.vercel.app`
 * host. The production host is `squadlogic.vercel.app`, so a production build
 * made without the Supabase variables served the mock (and its sign-in page)
 * to real visitors instead of refusing to start. The rule now: a production
 * build (`import.meta.env.PROD`) missing `VITE_SUPABASE_URL` or
 * `VITE_SUPABASE_ANON_KEY` refuses on every host, unless it was built with the
 * explicit opt-in `VITE_USE_MOCK_SUPABASE=true` (what Playwright and CI set).
 * Development (the Vite dev server) still falls back to the mock.
 *
 * Each case loads the real module fresh, with the build flags and variables
 * stubbed and jsdom's URL set to the host, so the module-level guard runs
 * exactly as it does when the browser evaluates the bundle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const PRODUCTION_HOST = 'squadlogic.vercel.app';
const PREVIEW_HOST = 'squadlogic-git-some-branch-joela510.vercel.app';
const HOSTS = [PRODUCTION_HOST, PREVIEW_HOST, 'localhost', '127.0.0.1', 'app.example.org'];

/** The Supabase URL and key names, VITE_ and the bare ones config.js once read. */
const SUPABASE_VARS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
];

/**
 * Loads config.js as a build with these flags would evaluate it, on `host`.
 * `vars` sets variables; every Supabase variable not named is unset (stubbed
 * to '', which config.js treats as missing), so the shell running the tests
 * cannot leak real values into a case.
 * @param {{ prod: boolean, host: string, vars?: Record<string, string> }} options
 */
async function loadConfig({ prod, host, vars = {} }) {
  vi.resetModules();
  vi.stubEnv('PROD', prod);
  vi.stubEnv('DEV', !prod);
  for (const name of [...SUPABASE_VARS, 'VITE_USE_MOCK_SUPABASE']) {
    vi.stubEnv(name, vars[name] ?? '');
  }
  setHost(host);
  document.body.innerHTML = '<div id="root"></div>';
  return import('../frontend/src/config.js');
}

/** Points jsdom's URL at `host` (Vitest's jsdom environment exposes the JSDOM instance). */
function setHost(/** @type {string} */ host) {
  /** @type {any} */ (globalThis).jsdom.reconfigure({ url: `https://${host}/` });
}

afterEach(() => {
  vi.unstubAllEnvs();
  document.body.innerHTML = '';
});

describe('mock-mode guard: a production build without Supabase configuration', () => {
  it('the cases run on the hosts they name (meta: jsdom URL is really changed)', () => {
    // A reconfigure that silently did nothing would leave every case on jsdom's
    // default host, and the per-host cases below would test one host five times.
    const seen = [];
    for (const host of HOSTS) {
      setHost(host);
      seen.push(window.location.hostname);
    }
    expect(seen).toEqual(HOSTS);
  });

  it.each(HOSTS)('refuses to start on %s and shows the Configuration Error', async (host) => {
    await expect(loadConfig({ prod: true, host })).rejects.toThrow(
      /production build has no Supabase configuration/
    );
    const root = document.getElementById('root');
    expect(root?.textContent).toContain('Configuration Error');
    expect(root?.textContent).toContain('VITE_SUPABASE_URL');
    expect(root?.textContent).toContain('VITE_USE_MOCK_SUPABASE=true');
  });

  it.each([
    ['VITE_SUPABASE_URL', { VITE_SUPABASE_ANON_KEY: 'anon-key-placeholder' }],
    ['VITE_SUPABASE_ANON_KEY', { VITE_SUPABASE_URL: 'https://project.supabase.example' }],
  ])('refuses with only %s missing', async (_missing, vars) => {
    await expect(loadConfig({ prod: true, host: PRODUCTION_HOST, vars })).rejects.toThrow(
      /production build has no Supabase configuration/
    );
  });

  it.each(HOSTS)(
    'runs the mock on %s when built with VITE_USE_MOCK_SUPABASE=true',
    async (host) => {
      const config = await loadConfig({
        prod: true,
        host,
        vars: { VITE_USE_MOCK_SUPABASE: 'true' },
      });
      expect(config.IS_MOCK_MODE).toBe(true);
      expect(document.getElementById('root')?.textContent).toBe('');
    }
  );

  it('runs the real client when both variables are set', async () => {
    const config = await loadConfig({
      prod: true,
      host: PRODUCTION_HOST,
      vars: {
        VITE_SUPABASE_URL: 'https://project.supabase.example',
        VITE_SUPABASE_ANON_KEY: 'anon-key-placeholder',
      },
    });
    expect(config.IS_MOCK_MODE).toBe(false);
    expect(config.SUPABASE_URL).toBe('https://project.supabase.example');
  });
});

describe('mock-mode guard: development', () => {
  it.each(HOSTS)('falls back to the mock on %s without Supabase variables', async (host) => {
    const config = await loadConfig({ prod: false, host });
    expect(config.IS_MOCK_MODE).toBe(true);
    expect(document.getElementById('root')?.textContent).toBe('');
  });
});
