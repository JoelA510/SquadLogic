/// <reference types="vite/client" />
/**
 * The frontend's environment: the only module that reads `import.meta.env`
 * (plan item M2.2, audit findings 2.2 and 8.4).
 *
 * Each variable is read by name, `import.meta.env.NAME`, never the object as a
 * whole: Vite replaces a whole-object read with every `VITE_` variable present
 * at build time, so the next secret given a `VITE_` name would ship to every
 * visitor. The values are validated by `envRules.js`, the same rules
 * `vite.config.js` runs when a build starts, so a production build with a
 * missing or malformed variable fails there and never reaches a browser.
 *
 * `config.js` re-exports what the rest of the app reads. `tests/env.test.js`
 * and `tests/mockModeGuard.test.js` hold this module.
 */
import { formatEnvProblems, validateClientEnv } from './envRules.js';

/** `vite build` (`import.meta.env.PROD`); false on the dev server and in Vitest. */
export const IS_PRODUCTION_BUILD = import.meta.env.PROD === true;

/** The Vite dev server (and Vitest). */
export const IS_DEV = import.meta.env.DEV === true;

/**
 * The Vite dev server only: `MODE` is `development` there, `test` in Vitest
 * and `production` in a build. For dev-only console warnings that would bury
 * test output (`IS_DEV` is true in Vitest too). Replaces the old
 * `process.env.NODE_ENV === 'development'` reads (plan M6).
 */
export const IS_DEVELOPMENT_MODE = import.meta.env.MODE === 'development';

/**
 * Build-time: can this build ever run the mock? Vite replaces both reads with
 * literals, so in a production build without `VITE_USE_MOCK_SUPABASE=true`
 * this is the literal `false`, and Rollup drops the mock's dynamic import in
 * `lib/supabaseClient.js`: the mock chunk is not emitted at all. A production
 * build without Supabase variables no longer exists to count here (it fails
 * at build time), which is why the credentials are not part of this test.
 */
export const MOCK_CAPABLE_BUILD =
  import.meta.env.DEV === true || import.meta.env.VITE_USE_MOCK_SUPABASE === 'true';

const { env, problems } = validateClientEnv(
  {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
    VITE_USE_MOCK_SUPABASE: import.meta.env.VITE_USE_MOCK_SUPABASE,
    VITE_SUPABASE_PERSISTENCE_URL: import.meta.env.VITE_SUPABASE_PERSISTENCE_URL,
    VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
  },
  { production: IS_PRODUCTION_BUILD }
);

/**
 * Production Safety Guard (fails closed; M1.7, moved here unchanged by M2.2).
 * A production build without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
 * refuses to start on every host: it never falls back to the mock. The host
 * plays no part. It once exempted `localhost` and every `*.vercel.app` host,
 * and the production host is `squadlogic.vercel.app`, so a build missing its
 * variables served the mock there (audit finding 5.1). The only way a
 * production build runs the mock is the explicit opt-in,
 * `VITE_USE_MOCK_SUPABASE=true` at build time (Playwright and CI set it).
 * Development (the Vite dev server) still falls back to the mock.
 *
 * Since M2.2 such a build fails in `vite build` (`vite.config.js`), so this
 * guard is the second line: it holds for a bundle built some other way.
 * `tests/mockModeGuard.test.js` holds this rule.
 */
if (problems.some((problem) => problem.kind === 'missing')) {
  const errorRoot = typeof document !== 'undefined' ? document.getElementById('root') : null;
  if (errorRoot) {
    errorRoot.innerHTML = `
        <div style="
          display: flex; align-items: center; justify-content: center;
          min-height: 100vh; background: #0f172a; color: #f1f5f9;
          font-family: system-ui, -apple-system, sans-serif; padding: 2rem;
        ">
          <div style="
            max-width: 480px; text-align: center; padding: 2.5rem;
            background: rgba(30, 41, 59, 0.8); border-radius: 1rem;
            border: 1px solid rgba(248, 113, 113, 0.3);
            box-shadow: 0 0 40px rgba(248, 113, 113, 0.1);
          ">
            <div style="font-size: 3rem; margin-bottom: 1rem;">&#9888;</div>
            <h1 style="font-size: 1.5rem; font-weight: 700; color: #f87171; margin-bottom: 0.75rem;">
              Configuration Error
            </h1>
            <p style="color: #94a3b8; line-height: 1.6; margin-bottom: 1.5rem;">
              This production build of SquadLogic has no Supabase configuration, so it will not start.
              Set <code style="color: #fbbf24; background: rgba(251,191,36,0.1); padding: 0.125rem 0.375rem; border-radius: 0.25rem;">VITE_SUPABASE_URL</code> and
              <code style="color: #fbbf24; background: rgba(251,191,36,0.1); padding: 0.125rem 0.375rem; border-radius: 0.25rem;">VITE_SUPABASE_ANON_KEY</code>
              in the deployment environment and rebuild, or build with
              <code style="color: #fbbf24; background: rgba(251,191,36,0.1); padding: 0.125rem 0.375rem; border-radius: 0.25rem;">VITE_USE_MOCK_SUPABASE=true</code>
              to run the mock on purpose.
            </p>
            <p style="color: #64748b; font-size: 0.875rem;">
              See <strong>docs/operations/ENVIRONMENT.md</strong> for setup instructions.
            </p>
          </div>
        </div>
      `;
  }
  throw new Error(
    '[SquadLogic] FATAL: this production build has no Supabase configuration ' +
      '(VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY), and was not built with ' +
      'VITE_USE_MOCK_SUPABASE=true. Aborting initialization.'
  );
}

// A malformed value. In a production bundle it stops the app (a build with
// one fails first, in vite.config.js, so this is the second line). On the dev
// server and in Vitest it is left out, as if unset, with a warning naming it:
// a .env copied from the old example (`your_supabase_project_url`) still runs
// the mock, as it did before these rules.
if (problems.length > 0) {
  const message = `[SquadLogic] Invalid environment (docs/operations/ENVIRONMENT.md):\n${formatEnvProblems(problems)}`;
  if (IS_PRODUCTION_BUILD) throw new Error(message);
  console.warn(`${message}\nOn the dev server each is ignored, as if unset.`);
}

export const SUPABASE_URL = env.supabaseUrl;
export const SUPABASE_ANON_KEY = env.supabaseAnonKey;
export const USE_MOCK_SUPABASE = env.useMockSupabase;
export const IS_MOCK_MODE = env.isMockMode;
export const API_BASE_URL = env.apiBaseUrl;

/**
 * The Sentry DSN, or `undefined`: Sentry is off. The literal check first lets
 * Vite and Rollup see a build without a DSN as `undefined`, so `main.jsx`'s
 * `if (SENTRY_DSN)` folds away and the SDK's init and integrations are not
 * bundled (measured, see the M2.2 PR).
 */
export const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN ? env.sentryDsn : undefined;

/** package.json's version, defined by `vite.config.js` at build time; Sentry's `release`. */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION;

/**
 * Vercel's `VERCEL_ENV` for the build (`production` / `preview` /
 * `development`), defined by name by `vite.config.js`; empty outside Vercel.
 * Sentry's `environment` (`lib/sentryOptions.js`).
 */
export const DEPLOY_ENV = import.meta.env.VITE_VERCEL_ENV;
