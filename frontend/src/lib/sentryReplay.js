/**
 * Sentry Session Replay, loaded on its own after `Sentry.init` (main.jsx).
 *
 * Replay is about 40 KB gzip, a third of the SDK's weight in the main entry,
 * and it records only to attach a replay to an error
 * (`replaysSessionSampleRate: 0`, lib/sentryOptions.js). So it is not part of
 * first paint: main.jsx imports this module dynamically and adds the
 * integration with `Sentry.addIntegration` once the chunk arrives, which is
 * the SDK's documented way to lazy-load an integration from npm. Its own
 * module gives the chunk a stable name, `sentryReplay-<hash>.js`, that the
 * bundle budget (config/bundle-budget.json) can hold. `lazyLoadIntegration`
 * was not used: it loads the integration from Sentry's CDN, which the CSP's
 * `script-src 'self'` refuses.
 */
export { replayIntegration } from '@sentry/react';
