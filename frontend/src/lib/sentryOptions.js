/**
 * The options `frontend/src/main.jsx` passes to `Sentry.init`, kept pure so a
 * unit test can pin them without booting the app. The DSN gate stays in
 * main.jsx: this only shapes the options once a DSN is present.
 *
 * @param {object} input
 * @param {string} input.dsn
 * @param {boolean} input.dev `import.meta.env.DEV`.
 * @param {string | undefined} input.release The build's version. main.jsx passes
 *   `import.meta.env.VITE_APP_VERSION`, which vite.config.js defines from
 *   package.json's `version` at build time.
 * @param {import('@sentry/react').BrowserOptions['integrations']} input.integrations
 * @returns {import('@sentry/react').BrowserOptions}
 */
export function sentryInitOptions({ dsn, dev, release, integrations }) {
  return {
    dsn,
    environment: dev ? 'development' : 'production',
    release,

    // Data minimisation, stated rather than defaulted: the SDK does not attach
    // the IP address, cookies or request headers by default. This does not
    // limit Session Replay or an explicit setUser call; those are governed
    // by their own settings.
    sendDefaultPii: false,

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
