/**
 * The rules for the frontend's build-time environment (plan item M2.2, audit
 * findings 2.2 and 8.4), kept free of `import.meta` so both sides can run them:
 *
 *   - `vite.config.js` runs them when `vite build` starts, so a production
 *     build with a missing or malformed variable fails, naming it, before a
 *     single file is written;
 *   - `frontend/src/env.js` runs them again in the browser on the values the
 *     build inlined, and is the only module that reads `import.meta.env`.
 *
 * Every value arrives as a string or `undefined` (Vite inlines `VAR=` as an
 * empty string, which counts as unset, as `config.js` always treated it).
 * `tests/env.test.js` holds these rules.
 */
import { z } from 'zod';

/** Every variable these rules read, by name. Nothing else is looked up. */
export const CLIENT_ENV_NAMES = /** @type {const} */ ([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_USE_MOCK_SUPABASE',
  'VITE_SUPABASE_PERSISTENCE_URL',
  'VITE_SENTRY_DSN',
]);

/** Where the persistence Edge Functions live when nothing else says (`supabase start`). */
export const LOCAL_FUNCTIONS_URL = 'http://localhost:54321/functions/v1';

/** @param {string} value */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    // `new URL` throws TypeError on anything that is not a URL; that is the
    // answer this function gives, not an error to report.
    return false;
  }
}

/**
 * A Sentry DSN: `https://<public key>@<host>/<project id>`, the shape the
 * SDK's own `dsnFromString` accepts. A DSN the SDK cannot parse makes
 * `Sentry.init` log a warning and send nothing, which is the silent failure
 * this rule turns into a build error.
 * @param {string} value
 */
function isSentryDsn(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      /^\w+$/.test(url.username) &&
      url.hostname.length > 0 &&
      /\/\d+$/.test(url.pathname)
    );
  } catch {
    // Not a URL, so not a DSN (see isHttpUrl).
    return false;
  }
}

/**
 * Supabase's secret keys bypass Row Level Security and must never reach the
 * browser (CLAUDE.md §2). Anything in `VITE_SUPABASE_ANON_KEY` is inlined into
 * the bundle, so a secret key there is refused: the new-style `sb_secret_`
 * keys, and a legacy JWT whose `role` claim is `service_role`.
 * @param {string} value
 */
function isSecretSupabaseKey(value) {
  if (value.startsWith('sb_secret_')) return true;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.role === 'service_role';
  } catch {
    // Not a decodable JWT payload, so it carries no role claim to refuse.
    return false;
  }
}

/** `''` and whitespace-only count as unset; anything else is trimmed. */
const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const schema = z.object({
  VITE_SUPABASE_URL: optionalText.refine(
    (value) => value === undefined || isHttpUrl(value),
    'must be an http(s) URL (Supabase → Settings → API → Project URL)'
  ),
  VITE_SUPABASE_ANON_KEY: optionalText.refine(
    (value) => value === undefined || !isSecretSupabaseKey(value),
    'is a Supabase secret (service-role) key; use the publishable (anon) key: anything here ships to every visitor'
  ),
  VITE_USE_MOCK_SUPABASE: optionalText.refine(
    (value) => value === undefined || value === 'true' || value === 'false',
    "must be 'true' or 'false' (or unset)"
  ),
  VITE_SUPABASE_PERSISTENCE_URL: optionalText.refine(
    (value) => value === undefined || isHttpUrl(value),
    'must be an http(s) URL (the Edge Functions base, ending /functions/v1)'
  ),
  VITE_SENTRY_DSN: optionalText.refine(
    (value) => value === undefined || isSentryDsn(value),
    'must be a Sentry DSN, https://<public key>@<host>/<project id>; leave it unset to turn Sentry off'
  ),
});

/**
 * @typedef {object} ClientEnv
 * @property {string | undefined} supabaseUrl
 * @property {string | undefined} supabaseAnonKey
 * @property {boolean} useMockSupabase The explicit opt-in, `VITE_USE_MOCK_SUPABASE=true`.
 * @property {boolean} isMockMode The mock runs: the opt-in, or a dev server without both Supabase variables.
 * @property {string} apiBaseUrl The persistence Edge Functions base, without a trailing slash.
 * @property {string | undefined} sentryDsn Unset: Sentry is off.
 */

/**
 * @typedef {object} EnvProblem
 * @property {string} name The variable at fault.
 * @property {'missing' | 'invalid'} kind
 * @property {string} message
 */

/**
 * Validates the raw values against the rules. Never throws: the caller
 * decides what a problem stops (the build, or the app's start). A rejected
 * value is left out of `env`, as if unset.
 *
 * In a production build (`vite build`, `import.meta.env.PROD`) the Supabase
 * URL and key are required unless `VITE_USE_MOCK_SUPABASE=true`, the one way
 * to build the mock on purpose (Playwright and E2E; M1.7). A dev server
 * without them falls back to the mock.
 *
 * @param {Partial<Record<(typeof CLIENT_ENV_NAMES)[number], string | undefined>>} raw
 * @param {{ production: boolean }} options
 * @returns {{ env: ClientEnv, problems: EnvProblem[] }}
 */
export function validateClientEnv(raw, { production }) {
  /** @type {EnvProblem[]} */
  const problems = [];
  /** @type {Record<string, string | undefined>} */
  const values = {};

  // Each variable alone, so one bad value never hides another's problem and
  // a valid variable keeps its value when a neighbour is rejected.
  for (const name of CLIENT_ENV_NAMES) {
    const result = schema.shape[name].safeParse(raw[name]);
    if (result.success) {
      values[name] = result.data;
    } else {
      values[name] = undefined;
      for (const issue of result.error.issues) {
        problems.push({ name, kind: 'invalid', message: issue.message });
      }
    }
  }

  const useMockSupabase = values.VITE_USE_MOCK_SUPABASE === 'true';
  const supabaseUrl = values.VITE_SUPABASE_URL;
  const supabaseAnonKey = values.VITE_SUPABASE_ANON_KEY;

  if (production && !useMockSupabase) {
    for (const name of /** @type {const} */ (['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])) {
      if (raw[name] === undefined || String(raw[name]).trim() === '') {
        problems.push({
          name,
          kind: 'missing',
          message:
            'is required in a production build; set it, or build with VITE_USE_MOCK_SUPABASE=true to ship the mock on purpose',
        });
      }
    }
  }

  const isMockMode = useMockSupabase || !supabaseUrl || !supabaseAnonKey;

  // The persistence base: the explicit value; else, in a production build of
  // the real client, the project's own Functions URL (what the
  // `frontend:build` wrapper, scripts/configurePersistenceEndpoint.js, derives
  // too, so a bare `vite build` cannot fall back to localhost); else the local
  // stack, as before. Never derived in mock mode or on the dev server: a mock
  // session must not post to the real project's Edge Functions.
  const persistenceUrl =
    values.VITE_SUPABASE_PERSISTENCE_URL ??
    (production && !isMockMode && supabaseUrl
      ? `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`
      : LOCAL_FUNCTIONS_URL);

  return {
    env: {
      supabaseUrl,
      supabaseAnonKey,
      useMockSupabase,
      isMockMode,
      apiBaseUrl: persistenceUrl.replace(/\/+$/, ''),
      sentryDsn: values.VITE_SENTRY_DSN,
    },
    problems,
  };
}

/**
 * One line per problem, each naming its variable; values are never printed.
 * @param {EnvProblem[]} problems
 */
export function formatEnvProblems(problems) {
  return problems.map((problem) => `  - ${problem.name} ${problem.message}`).join('\n');
}
