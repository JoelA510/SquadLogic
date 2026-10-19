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

1. **Force a client-side error**. Against a preview, run it on the PR's preview
   URL instead of production; the event's `environment` tells them apart (step 2).
   - **Signed in** (the leg that shows the user and organization IDs): sign in,
     then DevTools → Console → `localStorage.setItem('__FORCE_ERROR__', 'true')`
     and load `/`. `__FORCE_ERROR__` is a flag, not a function: `DashboardPage`
     and `WorkflowPage` throw `E2E forced error for resilience testing.` while
     it is `'true'` (or `window.__FORCE_ERROR__ === true`). Expected: the React
     `ErrorBoundary` renders its fallback. Afterwards run
     `localStorage.removeItem('__FORCE_ERROR__')`.
   - **Signed out** (environment, release and CSP only): DevTools → Console →
     `setTimeout(() => { throw new Error('Sentry smoke') })`. Sentry's global
     error handler reports it; no page renders differently.
2. **Check Sentry** — within 60 seconds:
   - Sentry dashboard → Issues → most recent event.
   - Expected (signed-in leg): `Error: E2E forced error for resilience testing.`
     with `React.Component stack` populated (via the Sentry React integration).
   - Expected: `environment` is `preview` on a preview deploy and `production`
     on production. `vite.config.js` exposes Vercel's `VERCEL_ENV`, by name,
     as `import.meta.env.VITE_VERCEL_ENV`; `sentryEnvironment()` in
     `frontend/src/lib/sentryOptions.js` maps it (a dev server is always
     `development`; a build outside Vercel stays `production`).
   - Expected (signed-in leg): the event's user is `{ id, organization_id, role }`
     (IDs and the role only: no email, no name) and it carries an
     `organization_id` tag. `AuthContext` sets it on sign-in,
     `OrganizationContext` when the active organization is chosen or switched,
     and sign-out clears it (`logger.setUser` in `frontend/src/lib/logger.js`
     drops every other field; `tests/loggerUserContext.test.jsx` pins it).
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
   - Expected: no `Refused to create a worker from 'blob:...'` either. Session
     Replay starts its compression worker from a `blob:` URL; the CSP's
     `worker-src 'self' blob:` admits it (before it, workers fell back to
     `script-src`, which refuses `blob:`, and Replay sent uncompressed). See
     [`docs/security/csp.md`](../security/csp.md).

## Failure modes

| Symptom | Diagnosis | Remedy |
| --- | --- | --- |
| No event appears in Sentry within 5 minutes | DSN typo or bundle cache | Re-run the `curl \| grep` check from step 3 of One-time setup; re-deploy without cache. |
| Event appears but no React component stack | `Sentry.init({ integrations: [reactRouterV7BrowserTracingIntegration()] })` missing a component | Check `frontend/src/main.jsx` — the `Sentry.init` call must have the React integration. |
| Event appears with wrong or no release tag | Stale bundle, or the `define` in `vite.config.js` was removed | Re-deploy without cache; `tests/sentryConfig.test.js` pins the `define`, the `release` option, and the explicit `dataCollection` baseline. |
| CSP console errors (`Refused to connect to ...`) | CSP `connect-src` missing the Sentry ingest host | Add it to `connect-src` in `vercel.json` (see `docs/security/csp.md`). |

## De-commissioning

To stop sending errors to Sentry:

1. Remove `VITE_SENTRY_DSN` from Vercel.
2. Redeploy.
3. Confirm the `curl | grep` check from step 3 of One-time setup returns nothing.

No code change required — the frontend `Sentry.init` call is a no-op when the
DSN env var is absent (see `frontend/src/main.jsx`).
