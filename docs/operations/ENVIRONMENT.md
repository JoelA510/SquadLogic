[← Back to Documentation Index](../README.md)

---

# Environment Variables Reference

> **SquadLogic v1.0 — Production Configuration Guide**
>
> This document lists every environment variable required to deploy SquadLogic to production. It covers the Vercel frontend, Supabase Edge Functions, and CI/CD pipelines.

---

## Frontend (Vercel)

These variables are set in **Vercel → Project Settings → Environment Variables**. Variables prefixed with `VITE_` are bundled into the client-side JavaScript at build time.

Vercel reports the `squadlogic` project runtime as Node `24.x`, and as of
2026-06-12 CI verifies on Node 24 as well (the runtime-parity follow-up the
2026-05-02 release-prep check deferred). `package.json` still declares
`engines: >=20` as the minimum supported runtime.

| Variable | Required | Secret | Purpose | Source |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | **Yes** | No | Supabase project REST API URL | Supabase Dashboard → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | **Yes** | No | Supabase publishable (anon) key — enforces RLS | Supabase Dashboard → Settings → API → `anon` `public` key |
| `VITE_SENTRY_DSN` | Recommended | No | Sentry DSN for frontend error tracking & performance monitoring | Sentry → Create Project → Browser JavaScript → DSN |
| `VITE_USE_MOCK_SUPABASE` | No | No | Force mock Supabase client (`true`). **Must be unset or `false` in production.** | Manual — development/CI only |
| `VITE_SUPABASE_PERSISTENCE_URL` | No | No | Override base URL for Edge Function persistence endpoints. Defaults to `http://localhost:54321/functions/v1` | Supabase Dashboard → Settings → API → Edge Functions URL |

### Production Safety

If `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are missing on a production domain (i.e. not `localhost` and not `*.vercel.app`), the application will refuse to start and display a **Configuration Error** screen. This guard is implemented in `frontend/src/config.js`.

---

## Supabase Edge Functions

These variables are set in **Supabase Dashboard → Edge Functions → Manage Secrets** (project-level). They are automatically injected into every Edge Function invocation via `Deno.env.get()`.

| Variable | Required | Secret | Purpose | Source |
|---|---|---|---|---|
| `SUPABASE_URL` | **Yes** | No | Auto-injected by Supabase. Project REST API URL. | Automatic |
| `SUPABASE_ANON_KEY` | **Yes** | No | Auto-injected by Supabase. Publishable key. | Automatic |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | **Yes** | Service-role key — bypasses RLS for server-side operations. **Never expose in client-side code.** | Supabase Dashboard → Settings → API → `service_role` `secret` key |
| `BETTERSTACK_SOURCE_TOKEN` | Recommended | **Yes** | BetterStack (Logtail) source token for structured JSON logging from Edge Functions. When absent, logs fall back to `console.*`. | BetterStack → Logs → Sources → Create Source (HTTP) → Token |
| `FUNCTION_NAME` | No | No | Override function name tag in BetterStack logs. Defaults to `'unknown'`. | Manual |
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
