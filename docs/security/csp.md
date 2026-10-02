[← Back to Documentation Index](../README.md)
---

# Content-Security-Policy — SquadLogic

> Canonical reference for the production CSP
> header set in [`vercel.json`](../../vercel.json). Lists every directive,
> rationale, and the concrete follow-ups for the two remaining loose
> directives (`style-src 'unsafe-inline'` and `connect-src` wildcard scoping).

## Current policy (enforcing, not Report-Only)

```
default-src 'self';
script-src  'self' https://vercel.live;
style-src   'self' 'unsafe-inline';
img-src     'self' data: blob: https://vercel.live https://vercel.com;
font-src    'self' https://vercel.live https://assets.vercel.com;
connect-src 'self'
            https://mmwupqsjkikqzvmdvuzm.supabase.co wss://mmwupqsjkikqzvmdvuzm.supabase.co
            https://*.ingest.sentry.io
            https://vercel.live wss://ws-us3.pusher.com
            https://api.weather.gov;
frame-src   'self' https://vercel.live;
frame-ancestors 'none';
object-src  'none';
base-uri    'self';
form-action 'self';
upgrade-insecure-requests;
```

Served as `Content-Security-Policy: …` (enforcing, flipped from Report-Only
during hardening). Sentry ingest was later added to `connect-src` (DSN
was set but captures were CSP-blocked). The `vercel.live` / `assets.vercel.com`
/ Pusher entries were added to unblock Vercel's preview-only comments &
feedback widget; they are inert on production deploys. `https://api.weather.gov`
was added for the field heat-stress (WBGT) forecast, which reads the NOAA
National Weather Service gridpoint forecast directly from the browser (see
§`api.weather.gov` below).

## Directive rationale

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Deny-by-default; anything not explicitly allowed below falls through to this. |
| `script-src` | `'self' https://vercel.live` | NO `'unsafe-inline'`. Bundled + hashed by Vite. `https://vercel.live` allows Vercel's preview Comments / feedback widget; the domain is Vercel-owned single-tenant with no guest content. A nonce- or `'strict-dynamic'`-based pattern is v1.1 work; `'self'` is a reasonable SPA baseline. |
| `style-src` | `'self' 'unsafe-inline'` | **Waiver** — Tailwind 4 runtime injects classes via dynamic `<style>` tags and React's `style={{...}}` prop renders inline. Nonce migration requires Tailwind 4.x nonce-propagation (not yet stable) + audit of every inline style site. See §`Follow-ups`. |
| `img-src` | `'self' data: blob: https://vercel.live https://vercel.com` | `data:` for small icons / placeholder SVGs in-bundle; `blob:` for the `OfflineGuard` Supabase-Storage-loaded brand assets. `vercel.live` + `vercel.com` for the preview feedback widget's avatars. No other third-party image CDNs. |
| `font-src` | `'self' https://vercel.live https://assets.vercel.com` | All app fonts bundled via Vite (`index.css` imports). The Vercel domains serve the Inter webfont referenced by the preview feedback widget. No Google Fonts / other third-party font CDNs. |
| `connect-src` | `'self' https://mmwupqsjkikqzvmdvuzm.supabase.co wss://mmwupqsjkikqzvmdvuzm.supabase.co https://*.ingest.sentry.io https://vercel.live wss://ws-us3.pusher.com https://api.weather.gov` | Allows (1) same-origin XHR, (2) the SquadLogic-specific Supabase project over HTTPS + WSS for Realtime, (3) Sentry ingest, (4) Vercel Live + its Pusher realtime channel for the preview feedback widget, (5) the NWS API for the heat forecast (exact host, no wildcard; see §`api.weather.gov`). **Supabase host is pinned** to the specific project ref — an earlier draft used `*.supabase.co`; Gemini PR #175 review correctly flagged the wildcard as an XSS-exfiltration broadening. If the project ref ever changes, update this directive in the same PR that updates the Supabase env vars. **Sentry is wildcard-scoped** to `*.ingest.sentry.io` because the Sentry SDK dispatches to region/org-specific subdomains (`o<id>.ingest.sentry.io`) not known at deploy time; the apex `ingest.sentry.io` is Sentry-operated single-tenant and does not host guest content. |
| `frame-src` | `'self' https://vercel.live` | The Vercel preview feedback widget mounts its UI inside an iframe that loads from `vercel.live`. Production traffic doesn't render the widget. No other embedded frames are permitted. |
| `frame-ancestors` | `'none'` | Clickjacking defense. SquadLogic is never embedded. |
| `object-src` | `'none'` | Legacy `<object>` / Flash blocker — zero legitimate use. |
| `base-uri` | `'self'` | Prevents `<base>` tag injection that would rewrite all relative URLs. |
| `form-action` | `'self'` | All form submissions stay on origin (Supabase RPCs go via fetch, not form POST). |
| `upgrade-insecure-requests` | present | Auto-upgrades any stray `http://` subresource to `https://` — defense against mixed-content regressions during refactors. |

## `api.weather.gov` (heat forecast)

Added with the field heat-stress (WBGT) forecast
([`docs/architecture/heat-forecast.md`](../architecture/heat-forecast.md)).
`frontend/src/lib/nwsClient.js` issues `GET /points/{lat},{lon}` and
`GET /gridpoints/{wfo}/{x},{y}` from the browser.

**Security review (the rule in §Editing the policy, item 3).**

- **Host, not wildcard.** Only `https://api.weather.gov`. `*.weather.gov` would
  admit every NWS web property; the client needs one.
- **What the origin is.** A U.S. government (NOAA/NWS) read-only JSON API. It
  hosts no user-supplied content and accepts no uploads; the client only issues
  GETs.
- **What it adds to the XSS threat model.** An injected script could already
  reach nothing outside `connect-src`; with this entry it can also send GETs to
  NWS. The only exfiltration channel that opens is data encoded into a request
  path or query, landing in NWS's own request logs -- not attacker-readable.
  The client additionally refuses to follow a `forecastGridData` URL that is not
  an `api.weather.gov/gridpoints/...` path, and the browser fetch carries no
  credentials (CORS default `same-origin` credentials mode).
- **CORS, verified live 2026-10-02** in Chromium 141, page served under the
  production CSP: both endpoints answer `access-control-allow-origin: *`, the
  request is CORS-simple (only `Accept: application/geo+json`; the preflight
  would allow only `API-Key, User-Agent`, so `Feature-Flags` must never be
  sent), and NWS's `application/problem+json` error bodies are readable. With
  the previous policy the same fetch was refused: "Refused to connect ...
  violates the following Content Security Policy directive: connect-src ...".
- **Client identification.** NWS asks for a User-Agent; browsers send their own
  and a script cannot set it. No API key exists yet; when NWS ships one, it is a
  follow-up (ROADMAP open items), not something to embed in the bundle.

`tests/cspPolicy.test.js` holds `vercel.json` and this document's §Current
policy to the same `connect-src` set.

## Companion headers (also in `vercel.json`)

- `X-Content-Type-Options: nosniff` — MIME sniffing off.
- `X-Frame-Options: DENY` — legacy frame-defense paired with `frame-ancestors 'none'`.
- `Referrer-Policy: strict-origin-when-cross-origin` — don't leak paths/query to third parties.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` — explicit deny on sensor APIs the app never uses.

## Known waivers + follow-ups

### Waiver 1 — `style-src 'unsafe-inline'`

- **Why**: Tailwind 4's runtime + React's `style={{...}}` prop emit inline styles throughout the SPA. A strict `style-src 'self'` policy would break rendering within seconds of load.
- **Follow-up**: v1.1+. Blocked on (a) a stable Tailwind 4 nonce-propagation API and (b) an audit of every `style={...}` site in `frontend/src/**`.
- **Interim discipline**: don't ADD new inline `<style>` tags; use Tailwind utility classes or CSS-var design tokens (`src/index.css`). Remaining hardcoded hex colors should be migrated to tokens before the nonce migration.

### Waiver 2 — `script-src 'self'` without `'strict-dynamic'` / nonce

- **Why**: Vite emits bundled scripts at known paths; `'self'` is sufficient for the SPA attack surface. A nonce-based policy is strictly tighter but adds build complexity.
- **Follow-up**: v1.1+. Preconditions: (a) Vercel Edge Middleware to mint a per-response nonce, (b) Vite plugin to inject the nonce into `<script>` tags at SSR/render time, (c) E2E test coverage for the nonce rotation.
- **Interim discipline**: do NOT inline any `<script>` in `frontend/index.html` or a component; everything must route through a Vite-bundled module.

### Missing — `report-uri` / `Content-Security-Policy-Report-Only`

- **Why**: free-tier Supabase doesn't include a CSP-report collector, and sending reports to a third-party (report-uri.com) introduces a new outbound dependency + bandwidth line item. Violations are caught by the E2E `console-errors` scenario + manual smoke per the production-cutover runbook.
- **Follow-up**: v1.1+ when observability budget allows a Sentry CSP-violation pipeline.

### Missing — Subresource Integrity (SRI)

- **Why**: all scripts are bundled self-hosted; no `<script>` tags pull from third-party CDNs. SRI is only meaningful when loading cross-origin bytes.
- **Follow-up**: N/A unless a future migration moves part of the bundle to a CDN.

## Editing the policy

1. Every directive change lands via a PR that touches `vercel.json` AND this doc.
2. **Adding a new third-party origin** (e.g., a new analytics provider) goes in `connect-src` and MUST include the specific host — never `*` by itself.
3. **Removing** an origin is free; widening requires a security-review comment in the PR explaining what threat model the new origin introduces.
4. After merge, the Vercel deploy picks up the new header on the next redeploy. Verify in the browser's Network tab (Response Headers) that the new value is served.

## Verification

After deploying a CSP change:

```bash
# 1. Fetch the header and pretty-print.
curl -sI https://squadlogic.vercel.app/ | awk '/^content-security-policy/i' | tr ';' '\n' | sed 's/^ //'

# 2. Expect: each directive on its own line, values as shown above.

# 3. Sentry ingest smoke (see docs/operations/sentry-smoke.md):
#    Open DevTools, run window.__FORCE_ERROR__(), confirm POST to
#    *.ingest.sentry.io returns 200/202 with NO CSP console warning.
```

If DevTools shows `Refused to connect to '...ingest.sentry.io' because it
violates the following Content Security Policy directive: "connect-src ..."`,
the deploy either used a stale cache (redeploy without cache) or the
`vercel.json` change was not included in the deploy (check `git log
vercel.json`).

## Related docs

- [`docs/operations/sentry-smoke.md`](../operations/sentry-smoke.md) — step-by-step DSN setup + CSP verification.
- The originating security-audit findings (CSP ingest gap; `style-src 'unsafe-inline'` waiver) are closed; the waiver rationale lives in §Waivers above.
