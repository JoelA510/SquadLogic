/**
 * The v10 default (`sendDefaultPii` off) for the privacy-relevant categories,
 * as Sentry's v11 migration guide tabulates it and spells it ("If you want to
 * keep the v10 default behavior"). A function, so no caller shares or mutates
 * another's nested objects. Query parameters get the same network-address deny
 * list as headers, as the guide's baseline does: v10 with `sendDefaultPii` off
 * filtered them the same way (Codex on #616).
 * `stackFrameVariables` and `frameContextLines` are not pinned: neither is
 * something `sendDefaultPii` governed, and neither sends data in a browser.
 */
export const NETWORK_ADDRESS_DENYLIST = Object.freeze([
  'forwarded',
  '-ip',
  'remote-',
  'via',
  '-user',
]);

export function dataCollectionBaseline() {
  const networkAddress = () => ({ deny: [...NETWORK_ADDRESS_DENYLIST] });
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: networkAddress(), response: networkAddress() },
    httpBodies: [],
    urlQueryParams: networkAddress(),
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
  };
}

/**
 * The options `frontend/src/main.jsx` passes to `Sentry.init`, kept pure so a
 * unit test can pin them without booting the app. The DSN gate stays in
 * main.jsx: this only shapes the options once a DSN is present.
 *
 * @param {object} input
 * @param {string} input.dsn
 * @param {boolean} input.dev `IS_DEV` from env.js (`import.meta.env.DEV`).
 * @param {string | undefined} input.release The build's version. main.jsx passes
 *   env.js's `APP_VERSION` (`VITE_APP_VERSION`), which vite.config.js defines
 *   from package.json's `version` at build time.
 * @param {string | undefined} [input.deployEnv] Vercel's `VERCEL_ENV` for the
 *   build. main.jsx passes env.js's `DEPLOY_ENV` (`VITE_VERCEL_ENV`), which
 *   vite.config.js defines from exactly that one variable at build time.
 * @param {import('@sentry/react').BrowserOptions['integrations']} input.integrations
 * @returns {import('@sentry/react').BrowserOptions}
 */
export function sentryInitOptions({ dsn, dev, release, deployEnv, integrations }) {
  return {
    dsn,
    environment: sentryEnvironment({ dev, deployEnv }),
    release,

    // Data minimisation, stated rather than defaulted: no IP address, cookies,
    // request or response bodies, or GenAI/database/queue data.
    // `dataCollection` replaced `sendDefaultPii` in SDK v11, and an unset
    // `dataCollection` collects all of them, so it is never left unset. This
    // does not limit Session Replay or an explicit setUser call; those are
    // governed by their own settings.
    dataCollection: dataCollectionBaseline(),

    // React-specific integrations
    integrations,

    // Free tier budget: 10k errors + 10k perf txns / month
    tracesSampleRate: dev ? 1.0 : 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: dev ? 1.0 : 0.5,

    // Filter noisy console breadcrumbs in dev
    beforeBreadcrumb(breadcrumb) {
      if (dev && breadcrumb.category === 'console') return null;
      return breadcrumb;
    },
  };
}

/** The Vercel environments an event may be tagged with, as `VERCEL_ENV` names them. */
const VERCEL_ENVIRONMENTS = ['production', 'preview', 'development'];

/**
 * The Sentry `environment` for a build. A dev server is always `development`.
 * A Vercel build takes Vercel's own name for the deploy, so a preview's events
 * read `preview` and are never mistaken for production's. Any other build (no
 * `VERCEL_ENV`, or a value Vercel does not use) keeps the previous default,
 * `production`.
 * @param {{ dev: boolean, deployEnv?: string }} input
 * @returns {string}
 */
export function sentryEnvironment({ dev, deployEnv }) {
  if (dev) return 'development';
  return VERCEL_ENVIRONMENTS.includes(deployEnv ?? '') ? String(deployEnv) : 'production';
}
