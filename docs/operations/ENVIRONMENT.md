[← Back to Documentation Index](../README.md)

---

# Environment Variables Reference

> **SquadLogic v1.0 — Production Configuration Guide**
>
> This document lists every environment variable required to deploy SquadLogic to production. It covers the Vercel frontend, Supabase Edge Functions, and CI/CD pipelines.

---

## Frontend (Vercel)

These variables are set in **Vercel → Project Settings → Environment Variables**. Variables prefixed with `VITE_` are bundled into the client-side JavaScript at build time.

### Node runtime

One Node version, pinned once: `.nvmrc` holds `24`, and `package.json`
`engines.node` is `^24.0.0`. CI reads `.nvmrc` in every `setup-node` step
(`ci.yml`, `pgtap.yml`). The Vercel project builds on Node `24.x` (read from
the Vercel API, `nodeVersion: "24.x"`, 2026-10-13). Vercel also reads
`engines.node`: when `package.json` names a major, it overrides the dashboard's
Node.js Version setting, so `engines` is what pins the Vercel build. To move to
another major, change `.nvmrc` and `engines` together in one PR; the
dashboard setting then only needs to match. CI ran Node 20 (end of life) until
2026-10 (audit finding 7.2, plan item M1.4).

| Variable | Required | Secret | Purpose | Source |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | **Yes** | No | Supabase project REST API URL | Supabase Dashboard → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | **Yes** | No | Supabase publishable (anon) key — enforces RLS | Supabase Dashboard → Settings → API → `anon` `public` key |
| `VITE_SENTRY_DSN` | Recommended | No | Sentry DSN for frontend error tracking & performance monitoring | Sentry → Create Project → Browser JavaScript → DSN |
| `VERCEL_ENV` | No (set by Vercel) | No | Vercel's own system variable (`production` / `preview` / `development`). `vite.config.js` exposes exactly this one, by name, as `import.meta.env.VITE_VERCEL_ENV`, and it becomes the Sentry event `environment`, so preview events are not reported as production. Outside Vercel it is empty and the environment stays `production`. Not set by hand. | Vercel system environment variable |
| `VITE_USE_MOCK_SUPABASE` | No | No | Force mock Supabase client (`true`). The only way a production build runs the mock (see Production Safety). **Must be unset or `false` in production.** | Manual — development/CI only |
| `VITE_SUPABASE_PERSISTENCE_URL` | No | No | Override base URL for Edge Function persistence endpoints. Defaults to `http://localhost:54321/functions/v1` | Supabase Dashboard → Settings → API → Edge Functions URL |

### Production Safety

A production build (`vite build`, so `import.meta.env.PROD`) made without
`VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` refuses to start and shows a
**Configuration Error** screen, on every host: the production host,
`*.vercel.app` previews, `localhost` and a custom domain alike. It never falls
back to the mock. The guard is in `frontend/src/config.js` and
`tests/mockModeGuard.test.js` holds it.

- **The opt-in.** A production build runs the mock only when it was built with
  `VITE_USE_MOCK_SUPABASE=true`. Playwright and CI set it; nothing else should.
  `VITE_` variables are read at build time, so setting or removing it takes a
  rebuild (a redeploy of an existing build does not pick it up).
- **Development** (the Vite dev server, `npm run frontend:dev`) still falls
  back to the mock when the Supabase variables are missing.
- **Vercel previews.** A preview built without the Supabase variables now shows
  the Configuration Error instead of the mock. Give the Preview environment the
  Supabase variables (a non-production project), or `VITE_USE_MOCK_SUPABASE=true`
  if previews should run the mock.

Before 2026-10 the guard exempted `localhost` and every `*.vercel.app` host.
The production host is `squadlogic.vercel.app`, so a production build missing
its variables served the mock and its sign-in page to real visitors (audit
finding 5.1, plan item M1.7). Plan item M2.2 turns the same rule into a build
failure.

### What the Vercel project sets

Read on 2026-10-13 (plan item M5.4). Names only; no value is recorded here. The Vercel API
refused to list the project's variables to the token used (403), so the Production list is
read from what the build embedded: the bundle of production deployment
`dpl_4sSoS5yHuf5TkxPXTUK94m69HhUg` (commit `64bd751`), checked for each name with a non-empty
value (*executed*).

| Environment | Set in Vercel | Not set |
|---|---|---|
| Production | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SENTRY_DSN` | `VITE_USE_MOCK_SUPABASE`; `VITE_SUPABASE_PERSISTENCE_URL` (the build derives it from `VITE_SUPABASE_URL`: its log says "Derived VITE_SUPABASE_PERSISTENCE_URL") |
| Preview | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (previews load production's Supabase project; see the remediation plan, "Discovered during execution", PR 1-B) | `VITE_SENTRY_DSN`: unverified |

- **Vercel's system variables reach the bundle.** For a Vite project Vercel also exposes its
  system variables with a `VITE_` prefix (`VITE_VERCEL_ENV`, `VITE_VERCEL_GIT_COMMIT_SHA`,
  `VITE_VERCEL_GIT_COMMIT_MESSAGE`, `VITE_VERCEL_GIT_COMMIT_AUTHOR_LOGIN`,
  `VITE_VERCEL_GIT_COMMIT_AUTHOR_NAME`, `VITE_VERCEL_URL`, and the rest). Because
  `frontend/src/config.js` reads `import.meta.env` as a whole (audit finding 8.4, plan item
  M2.2), all of them are in the production bundle today, the last commit's message and its
  author's name among them. None is a secret; M2.2's named reads end it.
- **Variables without the `VITE_` prefix** that the Vercel project may hold cannot be listed
  without the API's permission; the build reads none of them except `VERCEL_ENV`.
- **To see the exact list:** Vercel → the `squadlogic` project → Settings → Environment
  Variables, or `vercel env ls` with a token that can read them.

---

## Supabase Edge Functions

These variables are set in **Supabase Dashboard → Edge Functions → Manage Secrets** (project-level). They are automatically injected into every Edge Function invocation via `Deno.env.get()`.

| Variable | Required | Secret | Purpose | Source |
|---|---|---|---|---|
| `SUPABASE_URL` | **Yes** | No | Auto-injected by Supabase. Project REST API URL. | Automatic |
| `SUPABASE_ANON_KEY` | **Yes** | No | Auto-injected by Supabase. Publishable key. | Automatic |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | **Yes** | Service-role key — bypasses RLS for server-side operations. **Never expose in client-side code.** | Supabase Dashboard → Settings → API → `service_role` `secret` key |
| `BETTERSTACK_SOURCE_TOKEN` | Recommended | **Yes** | BetterStack (Logtail) source token for structured JSON logging from Edge Functions. When absent, logs fall back to `console.*`. | BetterStack → Logs → Sources → Create Source (HTTP) → Token |
| `FUNCTION_NAME` | No | No | Function name tag on `edgeLogger.info/warn/error` entries; defaults to `'unknown'` (Supabase does not set it). Failure entries from `withFailureLogging` / `logFailure` name the function themselves, with the request ID and organization ID. | Manual |
| `GAME_PERSISTENCE_ALLOWED_ROLES` | No | No | Comma-separated list of roles allowed to persist game schedules. Defaults to `admin`. | Manual |
| `TEAM_PERSISTENCE_ALLOWED_ROLES` | No | No | Comma-separated list of roles allowed to persist team rosters. Defaults to `admin`. | Manual |
| `PRACTICE_PERSISTENCE_ALLOWED_ROLES` | No | No | Comma-separated list of roles allowed to persist practice schedules. Defaults to `admin`. | Manual |

### Edge Functions Inventory

| Function | Purpose |
|---|---|
| `auto-scheduler` | Hill Climbing practice schedule optimizer |
| `calendar-feed` | Public ICS calendar feed generation |
| `fairness-scoring` | Server-side fairness metric calculations |
| `game-persistence` | Transactional game schedule save/update |
| `import-validation` | CSV import validation and sanitization |
| `practice-persistence` | Transactional practice schedule save/update |
| `team-persistence` | Transactional team roster save/update |

---

## CI/CD (GitHub Actions)

These are set in **GitHub → Repository Settings → Secrets and Variables → Actions**.

| Variable | Required | Secret | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Scheduled keep-alive | No | Supabase URL used by the weekly keep-alive job |
| `VITE_SUPABASE_ANON_KEY` | Scheduled keep-alive | **Yes** | Anon key used by the weekly keep-alive job |

The E2E job runs against mock Supabase data and sets its test account values in
`.github/workflows/ci.yml`; those values are not required as repository secrets
unless a future workflow switches to live test accounts.

### Scheduled Raw-Import Cleanup

The raw-import retention workflow uses Supabase Storage REST APIs and therefore
needs service-role access. Configure these in **GitHub → Repository Settings →
Secrets and variables → Actions** before enabling the scheduled job as a release
gate:

| Variable | Required | Secret | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | Raw-import cleanup | No | Supabase project URL for Storage REST API calls |
| `SUPABASE_SERVICE_ROLE_KEY` | Raw-import cleanup | **Yes** | Service-role key used only by the scheduled retention workflow |

---

## Local Development

1. Copy `.env.example` → `.env` (safe to commit — contains no secrets).
2. Copy `.env.local.example` → `.env.local` (gitignored — contains secrets).
3. Optionally copy `.env.test.example` → `.env.test` for E2E test credentials.

To run fully offline with mock data, set `VITE_USE_MOCK_SUPABASE=true` in `.env.local`. No Supabase credentials are required in this mode.

---

## Security Checklist

- [ ] `SUPABASE_SERVICE_ROLE_KEY` is **never** prefixed with `VITE_` (would bundle it in the browser).
- [ ] `VITE_USE_MOCK_SUPABASE` is **unset** or `false` in the Vercel production environment.
- [ ] `BETTERSTACK_SOURCE_TOKEN` is stored as a Supabase Edge Function secret, not in the repo.
- [ ] `VITE_SENTRY_DSN` is set in Vercel for production error visibility.
- [ ] `.env`, `.env.local`, and `.env.test` are listed in `.gitignore`.
