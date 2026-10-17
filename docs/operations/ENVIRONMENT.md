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
2026-10 (audit finding 7.2, plan item M1.4). `@types/node` follows the same
major (`^24`, held there in `.github/dependabot.yml`), so typecheck refuses an
API only a newer Node has; move it with `.nvmrc`. `engine-strict` is not set:
`npm ci` on another Node warns (`EBADENGINE`) rather than failing, because
Dependabot runs npm on its own Node and would fail every update
(`docs/security/dependency-policy.md`, M2.3). `package.json` also pins the npm
in use (`packageManager`), which the install guards in `.npmrc` need.

| Variable | Required | Secret | Purpose | Source |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | **Yes** (production build) | No | Supabase project REST API URL. Must be an `http(s)` URL. | Supabase Dashboard → Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | **Yes** (production build) | No | Supabase publishable (anon) key — enforces RLS. A secret key (`sb_secret_…`, or a JWT whose `role` is `service_role`) is refused: everything here ships to the browser. | Supabase Dashboard → Settings → API → publishable / `anon` `public` key |
| `VITE_SENTRY_DSN` | Recommended | No | Sentry DSN for frontend error tracking & performance monitoring. Unset: Sentry is off. Malformed (not `https://<public key>@<host>/<project id>`): the build fails. | Sentry → Create Project → Browser JavaScript → DSN |
| `VERCEL_ENV` | No (set by Vercel) | No | Vercel's own system variable (`production` / `preview` / `development`). `vite.config.js` exposes exactly this one, by name, as `import.meta.env.VITE_VERCEL_ENV` (read in `frontend/src/env.js` as `DEPLOY_ENV`), and it becomes the Sentry event `environment`, so preview events are not reported as production. Outside Vercel it is empty and the environment stays `production`. Not set by hand. | Vercel system environment variable |
| `VITE_USE_MOCK_SUPABASE` | No | No | `true` forces the mock Supabase client, and is the only way a production build ships the mock (see Production Safety). `true`, `false` or unset; anything else fails the build. **Must be unset or `false` in production.** | Manual — development/E2E only |
| `VITE_SUPABASE_PERSISTENCE_URL` | No | No | Override base URL for the persistence Edge Functions. In a production build of the real client it defaults to `VITE_SUPABASE_URL` + `/functions/v1` (the `frontend:build` wrapper also derives it); in mock mode and on the dev server, to `http://localhost:54321/functions/v1` (the local stack), so a mock session never posts to the real project. Must be an `http(s)` URL. | Supabase Dashboard → Settings → API → Edge Functions URL |

### How the frontend reads its environment

`frontend/src/env.js` is the only module that reads `import.meta.env`, and it
reads each variable by name (`import.meta.env.VITE_SUPABASE_URL`), never the
object as a whole: Vite replaces a whole-object read with every `VITE_`
variable present at build time, so the next secret given a `VITE_` name would
ship to every visitor (audit finding 8.4). It validates the values with the
Zod rules in `frontend/src/envRules.js`; `config.js` re-exports what the app
reads. A test (`tests/env.test.js`) fails if any other frontend module reads
`import.meta.env`.

The same rules run twice:

- **When a production build starts** (`vite build`, through `vite.config.js`):
  a missing or malformed variable fails the build, with one line per variable
  naming it. Nothing is written, so a deploy missing its variables fails on
  Vercel instead of going READY.
- **In the browser**, on the values the build inlined. A production bundle
  with a malformed value stops. On the dev server (and in Vitest) a malformed
  value is ignored, as if unset, with a console warning naming it, so a `.env`
  copied from the old example (`your_supabase_project_url`) still runs the
  mock.

Every `VITE_` variable is public. A secret never gets a `VITE_` name.

### Production Safety

A production build (`vite build`, so `import.meta.env.PROD`) made without
`VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` **fails to build**, naming the
missing variable (plan item M2.2), unless it sets the opt-in below. It never
falls back to the mock.

- **The opt-in.** A production build runs the mock only when it was built with
  `VITE_USE_MOCK_SUPABASE=true`. Playwright's dev server and CI's E2E step set
  it; nothing deployed should.
  `VITE_` variables are read at build time, so setting or removing it takes a
  rebuild (a redeploy of an existing build does not pick it up).
- **Development** (the Vite dev server, `npm run frontend:dev`) still falls
  back to the mock when the Supabase variables are missing.
- **CI's build step** (`npm run build`) sets well-formed stand-ins
  (`https://ci-build.invalid` and an `sb_publishable_` placeholder), not the
  opt-in: the bundle-budget gate measures that build, and it should be the
  shape production ships (the real client, no mock chunk). It sets a stand-in
  `VITE_SENTRY_DSN` too (an `.invalid` host), so Sentry is bundled as in
  production (plan M6). It is never served.
- **Vercel.** Production and Preview both need the Supabase variables (they
  share the production project; owner decision 2026-10-13). A deploy without
  them now fails at build time, and Vercel keeps serving the previous
  deployment.
- **The runtime guard stays as a second line.** `frontend/src/env.js` still
  shows a **Configuration Error** screen and throws on every host if a bundle
  built some other way lacks the variables (`tests/mockModeGuard.test.js`).

History: before 2026-10 the runtime guard exempted `localhost` and every
`*.vercel.app` host. The production host is `squadlogic.vercel.app`, so a
production build missing its variables served the mock and its sign-in page to
real visitors (audit finding 5.1, plan item M1.7, which made the guard refuse on
every host). That guard ran before `Sentry.init`, so such a deploy went READY
and reported nothing; M2.2 moved the failure to the build.

### What the Vercel project sets

Read on 2026-10-13 (plan item M5.4). Names only; no value is recorded here. The Vercel API
refused to list the project's variables to the token used (403), so the Production list is
read from what the build embedded: the bundle of production deployment
`dpl_4sSoS5yHuf5TkxPXTUK94m69HhUg` (commit `64bd751`), checked for each name with a non-empty
value (*executed*).

| Environment | Set in Vercel | Not set |
|---|---|---|
| Production | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SENTRY_DSN` | `VITE_USE_MOCK_SUPABASE`; `VITE_SUPABASE_PERSISTENCE_URL` (the build derives it from `VITE_SUPABASE_URL`: its log says "Derived VITE_SUPABASE_PERSISTENCE_URL") |
| Preview | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (previews load production's Supabase project; see the remediation plan, "Discovered during execution", PR 1-B), `VITE_SENTRY_DSN` (#558's preview: a with-DSN main entry and a Sentry request on load) | `VITE_USE_MOCK_SUPABASE` (the preview runs the real client) |

- **Vercel's system variables reach the bundle.** For a Vite project Vercel also exposes its
  system variables with a `VITE_` prefix (`VITE_VERCEL_ENV`, `VITE_VERCEL_GIT_COMMIT_SHA`,
  `VITE_VERCEL_GIT_COMMIT_MESSAGE`, `VITE_VERCEL_GIT_COMMIT_AUTHOR_LOGIN`,
  `VITE_VERCEL_GIT_COMMIT_AUTHOR_NAME`, `VITE_VERCEL_URL`, and the rest). Because
  `frontend/src/config.js` read `import.meta.env` as a whole (audit finding 8.4), all of them
  were in the production bundle until M2.2, the last commit's message and its author's name
  among them. None is a secret. Since M2.2 `frontend/src/env.js` reads each variable by name, so
  none of them is bundled (a build with canary values embeds them on the old code and not on
  the new; `tests/env.test.js` fails on any whole-object read).
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
3. Optionally copy `.env.test.example` → `.env.test` for E2E credentials
   against a real backend (`TEST_ADMIN_EMAIL`, `TEST_COACH_EMAIL`,
   `TEST_PARENT_EMAIL`, `TEST_PASSWORD`). They are read at the Node layer by
   the Playwright steps (`tests/e2e/steps/auth_setup.ts`), never by the app,
   and carry no `VITE_` prefix, so they never reach the bundle. The mock
   client needs none of them: it accepts one fixed demo password,
   `test-password-123`.

To run fully offline with mock data, set `VITE_USE_MOCK_SUPABASE=true` in `.env.local` (or leave the Supabase variables empty and use the dev server). No Supabase credentials are required in this mode.

---

## Security Checklist

- [ ] `SUPABASE_SERVICE_ROLE_KEY` is **never** prefixed with `VITE_` (would bundle it in the browser).
- [ ] `VITE_USE_MOCK_SUPABASE` is **unset** or `false` in the Vercel production environment.
- [ ] `BETTERSTACK_SOURCE_TOKEN` is stored as a Supabase Edge Function secret, not in the repo.
- [ ] `VITE_SENTRY_DSN` is set in Vercel for production error visibility.
- [ ] No variable holding a secret has a `VITE_` name (the build refuses a Supabase secret key in `VITE_SUPABASE_ANON_KEY`; `npm run check:advisors` flags a secret-shaped `VITE_` name in the `.env*.example` files; agent-ready-template's `scripts/check-env.mjs --root <repo>` checks names, reads and `define`s across the repo, run by hand or by the conformance scorecard, not by CI).
- [ ] `.env`, `.env.local`, and `.env.test` are listed in `.gitignore`.
