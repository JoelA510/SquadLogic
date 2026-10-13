[← Back to Documentation Index](../README.md)
---

# Sentry Integration — Smoke Test Runbook

> **Audit F-2-05 + progress-log `PHASE-9`**: the `@sentry/react` SDK is wired in
> `frontend/src/main.jsx` and `frontend/src/components/ErrorBoundary.jsx`, but
> `VITE_SENTRY_DSN` must be populated in Vercel **Production** (and **Preview**
> if you want preview errors captured) for errors to actually reach Sentry.
> This runbook is the smoke operators run after setting the DSN.

## Prerequisites

- The Sentry project `squadlogic` (type "React"), in the `secureyourtech`
  organization.
- The project's DSN string. The organization is in Sentry's **US region**, so
  its format is `https://<key>@o<org-id>.ingest.us.sentry.io/<project-id>`
  (other regions use `o<org-id>.ingest.sentry.io` or
  `o<org-id>.ingest.<region>.sentry.io`). The DSN is a public client key, but it
  lives only in Vercel's `VITE_SENTRY_DSN`; never commit it.
- Vercel project access (the `squadlogic` project on the `secureyourtech` team).
- 5 minutes for the redeploy.

## One-time setup

1. **Set the env var in Vercel**:
   - Vercel dashboard → Settings → Environment Variables → Add.
   - Key: `VITE_SENTRY_DSN`. Value: the DSN string. Environments: Production (required), Preview (recommended).
   - **Do NOT set `Development`** — local `npm run dev` does not need prod error capture.
2. **Re-deploy production**:
   - Vercel dashboard → Deployments → top of the Production branch → Redeploy.
   - Alternatively, push any no-op commit to `main` to trigger an auto-deploy.
3. **Confirm the bundle includes the DSN**:
   ```bash
   ENTRY=$(curl -s https://squadlogic.vercel.app/ | grep -oE '/assets/index-[^"]+\.js' | head -1)
   curl -s "https://squadlogic.vercel.app${ENTRY}" | grep -oE "ingest\.(us\.)?sentry\.io[^\"']*" | head -3
   ```
   The DSN is compiled into the entry script, not `index.html`, so the first
   line finds that script. If `ENTRY` comes back empty, the entry script was
   renamed: take the `<script type="module" src=...>` path from `index.html`
   instead. The `(us\.)?` makes the pattern match the US-region host
   (`ingest.us.sentry.io`) as well as `ingest.sentry.io`.
   Expected output: at least one `ingest.us.sentry.io/<id>` match. If the command
   returns nothing, the env var was not included in the build (most commonly
   because the redeploy used cached artifacts — trigger a fresh deploy with
   `[skip cache]` in the commit message or via Vercel's "Redeploy without cache").

## Smoke test (run once after each DSN change)

1. **Force a client-side error** via the `__FORCE_ERROR__` E2E hook:
   - Open https://squadlogic.vercel.app/ in an incognito window.
   - DevTools → Console → run: `window.__FORCE_ERROR__()`.
   - Expected: the React `ErrorBoundary` renders its glass-panel fallback.
2. **Check Sentry** — within 60 seconds:
   - Sentry dashboard → Issues → most recent event.
   - Expected: a `TypeError` (or whatever `__FORCE_ERROR__` throws) with
     `React.Component stack` populated (via the Sentry React integration).
   - Expected: the event's `release` tag equals the current `package.json`
     `version`. `vite.config.js` defines `import.meta.env.VITE_APP_VERSION` from
     `package.json` at build time and `frontend/src/main.jsx` passes it to
     `Sentry.init` as `release` (options built in
     `frontend/src/lib/sentryOptions.js`). No Vercel env var is needed for it.
3. **Check the network tab** of the incognito window:
   - Expected: a successful `POST https://o<org-id>.ingest.us.sentry.io/api/<project-id>/envelope/` returning 200/202.
   - **If blocked by CSP**: the CSP `connect-src` must include
     `https://*.ingest.us.sentry.io` for a US-region project. The older
     `https://*.ingest.sentry.io` entry does not match it: a CSP host wildcard
     matches only hosts ending in `.ingest.sentry.io`. Both entries are in
     `vercel.json` (see [`docs/security/csp.md`](../security/csp.md)).
   - **Known, separate warning (not an ingest failure)**: after an error,
     Session Replay may log `Refused to create a worker from 'blob:...'`. The
     CSP has no `worker-src`, so workers fall back to `script-src`, which does
     not admit `blob:`; Replay then sends uncompressed. Allowing it is a CSP
     change of its own, not part of the ingest fix.

## Failure modes

| Symptom | Diagnosis | Remedy |
| --- | --- | --- |
| No event appears in Sentry within 5 minutes | DSN typo or bundle cache | Re-run the `curl \| grep` check from step 3 of One-time setup; re-deploy without cache. |
| Event appears but no React component stack | `Sentry.init({ integrations: [reactRouterV7BrowserTracingIntegration()] })` missing a component | Check `frontend/src/main.jsx` — the `Sentry.init` call must have the React integration. |
| Event appears with wrong or no release tag | Stale bundle, or the `define` in `vite.config.js` was removed | Re-deploy without cache; `tests/sentryConfig.test.js` pins the `define`, the `release` option, and `sendDefaultPii: false`. |
| CSP console errors (`Refused to connect to ...`) | CSP `connect-src` missing the Sentry ingest host | Add it to `connect-src` in `vercel.json` (see `docs/security/csp.md`). |

## De-commissioning

To stop sending errors to Sentry:

1. Remove `VITE_SENTRY_DSN` from Vercel.
2. Redeploy.
3. Confirm the `curl | grep` check from step 3 of One-time setup returns nothing.

No code change required — the frontend `Sentry.init` call is a no-op when the
DSN env var is absent (see `frontend/src/main.jsx`).
