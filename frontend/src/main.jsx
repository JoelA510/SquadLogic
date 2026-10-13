import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App.jsx';
import { supabaseReady } from './lib/supabaseClient.js';
import { logger } from './lib/logger.js';
import { sentryInitOptions } from './lib/sentryOptions.js';
import './index.css';

// ---------------------------------------------------------------------------
// Sentry initialization — Phase 9 Production Hardening
//
// Gated behind VITE_SENTRY_DSN. When the env var is absent or empty,
// Sentry.init() is skipped entirely and the SDK tree-shakes to near-zero
// in the production bundle (Vite dead-code elimination).
// ---------------------------------------------------------------------------
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init(
    sentryInitOptions({
      dsn: SENTRY_DSN,
      dev: import.meta.env.DEV,
      release: import.meta.env.VITE_APP_VERSION,
      integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    })
  );
}

// ---------------------------------------------------------------------------
// App mount — withProfiler wraps <App /> for Sentry performance tracing
// (no-op if Sentry is not initialized)
// ---------------------------------------------------------------------------
const ProfiledApp = Sentry.withProfiler(App);

// Mock mode loads the mock client as its own chunk; render only once it is
// assigned (see lib/supabaseClient.js). The real client is ready at once.
// If the client cannot be set up, say so on the page: never a blank root.
const root = ReactDOM.createRoot(document.getElementById('root'));

supabaseReady.then(
  () =>
    root.render(
      <React.StrictMode>
        <ProfiledApp />
      </React.StrictMode>
    ),
  (error) => {
    logger.error('[Supabase] Client failed to initialize', error);
    root.render(
      <main className="empty" role="alert">
        <h1>SquadLogic could not start</h1>
        <p>The data client failed to load. Reload the page to try again.</p>
      </main>
    );
  }
);
