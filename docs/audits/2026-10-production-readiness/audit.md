# Audit

Repo: **JoelA510/SquadLogic** · Commit audited: `565e980` (origin/main, "fix(grid): read the season's current practice rows, not the latest run (#541)", the last commit before this run's process delivery `a63a9f8`) · Audited: 2026-10-12 · Auditor: Claude Code (Opus 5.5), running the `complete` skill from agent-ready-template 1.0.0-rc.3 (`00de8ae`), Phases 0-2 only (plan-only)

Complete means: an organization's administrator can import a season's GotSport registrations
(players, coaches, field slots), generate balanced teams, schedule practices and games against
real fields, publish the results to coaches and parents (exports, calendar feeds, the team
portal, RSVPs and messages), and record scores and standings, on the deployed Vercel + Supabase
app, seeing only their own organization, with every state change audited; coaches and parents
see and do only what their role allows. *(Assumption: derived from README "Overview",
"Features" and "Current Routes", and CLAUDE.md §1; no definition of complete is written down in
the repository. The owner should correct it if it is wrong, because the plan is ordered
against it.)*

Previous audit: [`../2026-07-production-readiness/audit.md`](../2026-07-production-readiness/audit.md)
(HEAD `1dccab7`, 38 findings). Where a July finding is still open it is re-raised here under its
area with the July ID beside it; where it was closed, that is noted in the area's current state.

## Severity

- **Blocker:** cannot responsibly ship: data loss, a security hole, an authorization bypass, a
  broken core flow.
- **High:** will hurt users or the team soon: an unenforced guarantee, a silent failure path, a
  missing test on logic people depend on.
- **Medium:** real debt with a schedule.
- **Low:** polish.

## Baseline (run before reading for findings)

All gates ran in a separate clean clone of `565e980`
(`git clone /home/user/SquadLogic <scratch>/clean`), never in the working tree, on Node 24.21.0 /
npm 11.19.0 (this sandbox; CI uses Node 20). Every result below is *executed*.

| Gate | Command | Result | Notes (counts, skips, flags it needed, environment) |
| --- | --- | --- | --- |
| Install | `npm ci` | PASS | Lockfile unchanged. npm 11 warns that `esbuild@0.25.12`'s postinstall is not covered by `allowScripts` (it did not run; the build still worked). `npm ci` printed 15 vulnerabilities (see Dependency audit). |
| Migration versions | `node scripts/ci/migrationVersions.mjs` | PASS | 127 files, all unique (push mode; the PR-mode base comparison was not exercised). |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | PASS | 0 errors, 37 s. Under `strict: false` (see 2.1). |
| Lint | `npm run lint` (`eslint . --max-warnings=1`) | PASS | 0 errors, 1 warning (`frontend/src/components/teaming/RosterManager.jsx:93`, `react-hooks/incompatible-library`), the one warning `--max-warnings=1` allows. |
| Unit / integration tests | `npm run test` (`vitest run`) | PASS | 306 files passed, 1 skipped; 5,108 tests passed, 34 skipped, 6 todo; 283 s. The 34 skipped are `tests/integration/staging.test.js`, which skips without staging credentials (6.2). No `NODE_OPTIONS` flag was needed on Node 24 (the July audit needed `--no-experimental-webstorage`; that is fixed). |
| E2E tests | `CI=true npm run test:e2e -- --workers=1` with the CI job's env (`VITE_USE_MOCK_SUPABASE=true`, the `TEST_*` values from `ci.yml`) | PASS | 92 of 92 scenarios passed in 9.1 min (29 features), against the in-browser mock only: every scenario logs "Skipping isolated tenant setup due to missing Supabase credentials or mock mode". Needed Playwright's Chromium 1208 (installed to a scratch `PLAYWRIGHT_BROWSERS_PATH`; the sandbox's own Chromium is revision 1194). Passing does not mean each scenario exercises what it names: see 6.6 and 13.3. |
| Coverage | `npm run test:coverage` | PASS | All files: statements 93.07%, branches 84.23%, functions 95.19%, lines 94.04%, above every configured threshold (60/50/55/60); 476 s. Not run by CI (6.1). |
| Build | `npm run frontend:build` | PASS | 15 s. `npm run build` is not a build (it imports six core modules and checks they are functions; see 7.5) and was not treated as one. |
| Bundle budget | `npm run check:bundle` | PASS | "all chunks within budget". Largest chunks: `chart-vendor` 118.9 KB gz, `index` 118.1 KB gz, `supabase-vendor` 49.7 KB gz. |
| Advisor lint | `npm run check:advisors` | PASS | 127 migration files + env examples, 0 violations. A regex approximation of Supabase's advisors, not the advisors themselves (8.6). |
| Database migrations, smokes, reverts | `HARNESS_PGUSER=postgres bash scripts/dbharness/run.sh` (`npm run test:db:local`) | PASS | "applied 127 migrations", 46 smoke PASS, 23 revert PASS, 1 emergency-rollback PASS, 1 scenario PASS, 0 FAIL, "HARNESS OK", 168 s, on a throwaway local PostgreSQL 16 cluster. Needed `HARNESS_PGUSER=postgres`: the default OS user `pgrunner` does not exist here and no doc names the requirement (4.2). |
| pgTAP | `npm run test:db` (`supabase test db`) | BLOCKED (ENVIRONMENT) | Needs the Supabase CLI and a local stack (`supabase start`, Docker); neither is available in this sandbox (no Docker daemon). CI runs it only on PRs that touch `supabase/**` (6.3). |
| Deno mirror tests, Edge type-check | `bash scripts/deno-mirror-tests.sh`, `bash scripts/deno-check-edge.sh` | BLOCKED (ENVIRONMENT) | No `deno` binary here. CI runs both on every push and PR (job `deno-mirror-tests`). |
| Staging integration | `tests/integration/staging.test.js` | SKIPPED | Needs staging Supabase credentials; the owner's constraints forbid touching shared environments. No gate runs it (6.2). |
| Dependency audit | `npm audit` | FAIL | 15 vulnerabilities: 8 high, 6 moderate, 1 low, 0 critical; none waived (`docs/security/dependabot-waivers.md` lists none and says `npm audit` reports 0). High: `react-router` (runtime), `vite`, `postcss`, `brace-expansion`, `browserslist`, `js-yaml`, `nanoid`, `source-map-js`. See 8.1. |
| Standards conformance | `node <template>/scripts/check-conformance.mjs --root <clean clone of 565e980> --visibility public` | FAIL (exit 1) | Packs detected: core, node, supabase, vite-spa. 17 fail, 9 pass, 3 n/a, 8 audit. Failing: `core.agent-rules`, `core.dependency-updates`, `core.instructions-resolve`, `core.lf-line-endings`, `core.license`, `core.process-delivered`, `core.security-policy`, `core.workflows-audited`, `node.audit-gate`, `node.ci-runs-gate`, `node.install-guards`, `node.runtime-pinned`, `node.strict-types`, `node.unused-code`, `supabase.advisors-in-ci`, `vite-spa.bundle-budget`, `vite-spa.client-env`. Scored on the audited commit, not the delivery; on the delivery commit `a63a9f8` the only change is `core.process-delivered` passing (16 fail, 10 pass). Two verdicts are refuted below (`vite-spa.bundle-budget`, `node.ci-uses-pin`). |
| Repository settings | `GITHUB_TOKEN=$(gh auth token) NODE_USE_ENV_PROXY=1 node <template>/scripts/check-settings.mjs --repo JoelA510/SquadLogic` | FAIL (exit 1) | 1 fail, 2 pass, 2 skipped. Fail: `core.settings-branch-protected` (confirmed: `GET /repos/.../branches/main` returns `protected: false`; `/rulesets` is `[]`). Pass: `core.settings-private-reporting`, `core.settings-secret-scanning`. Skipped for lack of admin read on the token: `core.settings-dependabot-alerts`, `core.settings-token-read-only` (not passed). |
| Environment checks | `node <template>/scripts/check-env.mjs --root <clean clone>` | FAIL (exit 1) | 3 findings in 22 variable names from 3 env files and 82 reads: `frontend/src/config.js:7` and `:8` read `import.meta.env` as a whole; `.env.test.example:11` `VITE_TEST_PASSWORD` is secret-named behind `VITE_`. See 8.4. |
| Agent instructions | `node <template>/scripts/check-instructions.mjs --root <clean clone>` | FAIL (exit 1) | 3 findings in 4 files (CLAUDE.md and the three `squadlogic-*` skills): each skill has no YAML frontmatter. CLAUDE.md's 66 paths, 2 links and 35 script references all resolve. See 12.2. |

Runtime: local 24.21.0 (this sandbox) / CI Node 20 (`.github/workflows/ci.yml`, `node-version: 20`; Node 20 reached end of life on 2026-04-30) / production: Vercel's dashboard setting, not in the repository; open PR #332 says "Vercel has built production on Node 24.x for weeks" (not verified: production was not touched). Edge Functions: Deno 2.9.6 in CI. No pin file.

## Known issues going in

- Issue #364 (open since 2026-09-05): `EvaluationPanel` on the practice page sends no teams or
  slots, so `fairness-scoring` always reports zero coach conflicts — source:
  https://github.com/JoelA510/SquadLogic/issues/364 — confirmed still present at `565e980`; see
  §13 (13.1).
- PR #332 (open, draft-free, since 2026-06-16): CI on Node 24 and Node-24-native actions, with
  an in-range dependency refresh — source: https://github.com/JoelA510/SquadLogic/pull/332 — see
  §7 (7.2) and §8 (8.1).
- PR #331 (open): Dependabot security update for `esbuild` — see §8 (8.2).
- PR #539 (open): blackout enact persistence, in flight; not audited.
- The July 2026 remediation plan (`docs/audits/2026-07-production-readiness/remediation-plan.md`):
  its four blockers were fixed by migrations `20260726000000`-`20260726000300` (statically
  reviewed; the harness applied and smoke-tested them, executed), but the plan has no status line
  and at least seven of its items are still open at `565e980` — see §12 (12.5) and the July IDs
  cited beside each re-raised finding.

## Summary

| # | Area | Severity of worst finding | One-line state |
| --- | --- | --- | --- |
| 1 | Architecture & boundaries | Medium | Clean core/frontend split; the scheduling engines exist twice (JS core and Deno ports), held together by mirror tests. |
| 2 | Type safety | High | `strict: false` everywhere by declared choice; no typed env module; client-side Zod mandated but unused on persistence payloads. |
| 3 | Auth & authorization | Medium | RLS on all 57 tables; July's three authz blockers fixed; RLS proven only by a path-filtered pgTAP job and the mock. |
| 4 | Data layer | Medium | Migrations, smokes and reverts all pass from scratch locally; that harness runs nowhere in CI and needs an undocumented OS user. |
| 5 | Error handling | High | Production's mock-mode guard exempts the production host itself; persistence calls have no timeout. |
| 6 | Testing | High | 5,108 unit tests pass; coverage thresholds never enforced in CI; E2E runs only against the in-browser mock; staging suite never runs. |
| 7 | CI/CD | High | CI runs on every PR but nothing requires it; a push to `main` deploys migrations to production; CI on an end-of-life Node. |
| 8 | Security | High | 8 unwaived high advisories and no audit gate; no SECURITY.md; no Dependabot version updates; secrets scan clean. |
| 9 | Observability | High | Sentry is wired but no event carries a user or organization; CSP may drop regional ingest; 1 of 7 Edge Functions ships logs. |
| 10 | Performance | Low | Bundle within its budget, measured; no hot spot found. |
| 11 | Accessibility & UX completeness | High | No automated accessibility check anywhere; the game grid is drag-only. |
| 12 | Docs, operability & stated-rule conformance | High | Agent rules only in CLAUDE.md, with internal contradictions; agent prompt packets kept in ordinary docs; July plan untracked. |
| 13 | Core flows | Blocker | The practice page's fairness evaluation reports a clean result after examining nothing (#364); the E2E scenarios named for team generation and practice and game scheduling write the engine's output themselves. |

## 1. Architecture & boundaries

- **Current state:** pure domain logic in `packages/core/src/` (no React imports; checked by
  grep), React in `frontend/src/`, persistence through Edge Functions and SECURITY DEFINER RPCs
  under `supabase/`. One Zod schema location (`packages/core/src/schemas/`). The Deno Edge
  Functions carry ports of the core engines in `supabase/functions/_shared/engines/` (8 files:
  `auto-scheduler-solver.ts`, `scoring-engine.ts`, `practice-*.ts`, `coach-preference*.ts`),
  tested against the core by 18 mirror tests (`supabase/functions/_shared/tests/`). The root
  `package.json` declares `"workspaces": ["frontend", "packages/*"]`, but `frontend/` has no
  `package.json`.
- **Findings:**
  - **1.1** `medium` `statically reviewed` — The practice scheduler and fairness scorer exist
    twice, as JavaScript in `packages/core/src/` and as Deno ports in
    `supabase/functions/_shared/engines/`; the same result is derived in two places. They have
    already drifted once: `.github/workflows/ci.yml` (job `deno-mirror-tests`, comment) records
    that `scoring-engine_test.ts` had never run and the engine under it published a negative
    `unassignedTeams`. Discovery-based mirror tests now run in CI, but a mirror test compares
    the two only on the inputs it names.
  - **1.2** `low` `executed` `node.unused-code` — No unused-code check runs in CI (no knip);
    the dead workspace entry (`"frontend"` in `package.json` `workspaces` with no
    `frontend/package.json`) is the kind of thing it would surface.
- **Pattern that closes the gap:** keep the two engines (moving the Edge Functions onto the core
  package is a flagged refactor; owner decision D4) but make drift loud: a parity test that runs
  both engines on the season-2026 corpus and on a non-empty fairness payload. Add knip to CI with
  the core package's exports as public API.

## 2. Type safety

- **Current state:** `tsconfig.json` sets `checkJs` and `allowJs` with `"strict": false`, over
  838 JavaScript files and 29 TypeScript files (`tests/e2e/steps/*.ts`, `tests/e2e/*.ts`, one in
  `tests/unit/`, one in `frontend/src/`). CLAUDE.md §4 documents `strict: false` as the
  project's choice. Edge Functions are type-checked by `deno check` in CI. Environment access is
  centralized in `frontend/src/config.js`, without validation.
- **Findings:**
  - **2.1** `high` `executed` `node.strict-types` — `strict` is off for every source file, the
    29 TypeScript files included; `checkJs` without `strict` does no null checking. Declared on
    purpose in CLAUDE.md §4 ("TypeScript (checkJs + allowJs, strict: false)"), so this is a
    conflict between the template's standard and the repository's stated rule (see Conflicts).
  - **2.2** `medium` `statically reviewed` — No typed env module. `frontend/src/config.js`'s
    `getEnvVar(key)` reads `import.meta.env[key]` and `process.env[key]` dynamically, validates
    nothing, and falls back silently (`API_BASE_URL` defaults to
    `http://localhost:54321/functions/v1`). A missing or malformed value is discovered at run
    time, in the user's browser.
  - **2.3** `medium` `statically reviewed` (July DS-2, still open) — CLAUDE.md §3 "Schema
    Rigidity" mandates Zod validation of all data updates, but
    `packages/core/src/schemas/index.js:113` `PersistencePayloadSchema` is referenced nowhere
    else (`grep -rn PersistencePayloadSchema frontend/src packages/core/src` finds only its
    definition): the team-persistence payload is sent unvalidated from the client.
- **Pattern that closes the gap:** one env module (`frontend/src/env.js`) that reads each
  variable by name (`import.meta.env.VITE_SUPABASE_URL`) and validates them with the Zod already
  in the core package, failing the build for a required one and leaving optional ones (Sentry)
  off when unset. Wire the existing schemas into the persistence clients. Strictness: record the
  current state as the baseline and treat raising it as a flagged refactor (D2).

## 3. Auth & authorization

- **Current state:** every one of the 57 tables created by a migration has an `enable row level
  security` statement (scorecard `supabase.rls-on-every-table` pass; re-checked independently by
  a grep over all 127 migrations, statically reviewed). July's blockers PB-1 (stale broad write
  policies), PB-2 (`organizations` write policy on a JWT claim) and PB-3
  (`record_audit_event` without authorization) are closed by migrations
  `20260726000000`-`20260726000200`, which the local harness applied, smoke-tested and reverted
  (executed). `user_metadata` is read once, for a display name
  (`frontend/src/hooks/useTeamPortal.js:398`), never for an authorization decision; the
  service-role key appears only in `.env.local.example` and Edge Functions
  (`supabase.secret-keys-server-only`, audit: met, statically reviewed). Route protection is
  `<ProtectedRoute requiredPermission>` with server-side RLS behind it.
- **Findings:**
  - **3.1** `medium` `statically reviewed` — Row-level security is proven only by the pgTAP
    suite (`supabase/tests/`), which runs in CI only when a PR touches `supabase/**`
    (`.github/workflows/pgtap.yml` `on.pull_request.paths`), and by E2E scenarios ("Multi-Tenancy
    Data Isolation (RLS)") that run against the in-browser mock, which enforces no RLS. A PR that
    changes how the client calls an RPC, without touching `supabase/`, runs no RLS test.
- **Pattern that closes the gap:** run pgTAP on every pull request and make it a required check
  (the repository is public, so Actions minutes on standard runners are free; the workflow's
  comment budgets for private-repo minutes). See 6.3.

## 4. Data layer

- **Current state:** 127 migrations, all named `<14-digit>_<name>.sql` and unique
  (`supabase.migration-names` pass; `migrationVersions.mjs` pass). Since `20260530000000` every
  migration has `docs/sql/<version>_revert.sql` and `_smoke.sql`; the harness applied the whole
  set to an empty PostgreSQL 16 cluster and ran 46 smokes and 23 reverts, all passing
  (executed). July's PB-4 (re-import wiping guardians) is closed by
  `20260726000300_finalize_import_reimport_coalesce.sql` (statically reviewed). Writes go through
  RPCs with `audit_log` rows. Client-persisted state is small: the theme (`sl-theme`), the active
  season (with an E2E scenario for an invalid stored value), and the mock database in
  sessionStorage.
- **Findings:**
  - **4.1** `low` `statically reviewed` — 81 migrations dated before 2026-05-30 have no revert or
    smoke script under `docs/sql/` (the convention started then). They are applied in production;
    a revert for them would be written only if one is ever needed.
  - **4.2** `medium` `executed` — The migration harness (`npm run test:db:local`,
    `scripts/dbharness/run.sh`) is the only thing that applies every migration from scratch and
    runs the reverts, and no CI job runs it. It also needs an OS user named `pgrunner` and
    PostgreSQL 16 at `/usr/lib/postgresql/16/bin`, which no README or CLAUDE.md section states;
    it ran here only with `HARNESS_PGUSER=postgres`. Its own header ("Nothing in CI executes a
    migration") is also out of date: pgTAP's `supabase start` applies them, on path-filtered PRs.
- **Pattern that closes the gap:** a CI job that runs the harness on every PR touching
  `supabase/` or `docs/sql/` (the runner image ships PostgreSQL; the harness needs no network),
  and a "Running the database harness" paragraph naming `HARNESS_PGUSER`.

## 5. Error handling

- **Current state:** a global `ErrorBoundary`, `logger.error` forwarding to Sentry when
  configured, a render-time fallback when the Supabase client fails to load
  (`frontend/src/main.jsx`), and E2E scenarios for persistence timeouts and offline recovery.
  The team-persistence client has a timeout; the game and practice clients do not.
- **Findings:**
  - **5.1** `high` `executed` — The production guard against mock mode exempts the
    production host. `frontend/src/config.js:34-77` throws only when the hostname is neither
    localhost nor `*.vercel.app`, and production is `https://squadlogic.vercel.app/` (README). A
    production build without `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` therefore loads the
    in-browser mock (`frontend/src/lib/supabaseClient.js:43-68`), whose `signInWithPassword`
    accepts `test-password-123` for any email and takes the role from the email's local part
    (`frontend/src/lib/mockSupabaseClient.js:2042-2048`). Real users would get a convincing,
    seeded, fake app, and anything they enter would live only in their sessionStorage: a silent
    failure on the one configuration error the guard exists for. Reproduced locally: the
    `frontend:build` output built without Supabase variables, served on 127.0.0.1 and opened in
    Chromium with `squadlogic.vercel.app` mapped to it (`--host-resolver-rules`), rendered the
    sign-in page, accepted `admin@anything.test` / `test-password-123`, and showed the admin
    dashboard of the seeded "SquadLogic FC" organization; the same build under
    `squadlogic.example.com` showed the guard's "Configuration Error". Production itself was not
    touched.
  - **5.2** `medium` `statically reviewed` (July DS-7, still open) — `persistGameScheduleReview`
    (`frontend/src/utils/gamePersistenceClient.js:34-55`) and the practice client issue `fetch`
    with no `AbortController` or timeout, so a hung Edge Function leaves the Apply button
    spinning forever; and `response.json().catch(() => ({}))` turns a 2xx with an unreadable body
    into an empty success object.
- **Pattern that closes the gap:** decide production by the build (`import.meta.env.PROD` plus an
  explicit `VITE_ALLOW_MOCK` for previews), never by hostname suffix; the env module of 2.2 makes
  the missing variables a build failure. Give every persistence call the team client's timeout
  helper, and treat an unparsable success body as an error.

## 6. Testing

- **Current state:** 5,108 Vitest tests over the core engines, hooks, components and scripts,
  including 33 test files that load the season-2026 corpus through the real engine entry points;
  92 Playwright-BDD scenarios in 29 features against the mock client; pgTAP under
  `supabase/tests/`; 18 Deno mirror tests; the local migration harness. Coverage thresholds
  (statements 60, branches 50, functions 55, lines 60) are configured in `vitest.config.js`.
- **Findings:**
  - **6.1** `high` `statically reviewed` (July TG-1, still open) — The coverage thresholds are
    never enforced: CI runs `npm run test` (`vitest run`), not `test:coverage`, so the
    thresholds in `vitest.config.js` fail nothing. Measured here, coverage is far above them
    (93.07 / 84.23 / 95.19 / 94.04 against 60 / 50 / 55 / 60, executed), so nothing is broken
    today; what's missing is the guarantee that a drop fails a PR.
  - **6.2** `medium` `executed` — `tests/integration/staging.test.js` (34 tests) skips whenever
    staging credentials are absent (`describe.skipIf(!canRun)`), which is every gate: no CI job
    provides them. It has no recorded passing run.
  - **6.3** `medium` `statically reviewed` — pgTAP runs only on PRs that touch `supabase/**`,
    `package.json` or its own workflow, so it cannot be a required check as written (a required
    check that doesn't run blocks the PR), and it pins Supabase CLI 2.95.4 while `ci.yml` pins
    2.118.0.
  - **6.4** `medium` `statically reviewed` (July TG-5/TG-6, not re-verified line by line) — Every
    E2E scenario runs against `frontend/src/lib/mockSupabaseClient.js`, a 2,000-line in-browser
    imitation of the backend. Where the mock's RPCs diverge from the real ones (the July audit
    found two such divergences), a scenario passes on behaviour production doesn't have. No
    end-to-end run exercises the real Supabase configuration.
  - **6.6** `medium` `statically reviewed` — CLAUDE.md §8's E2E rule 2 ("never assert on mock
    internal state or sessionStorage directly") is declared, not enforced: 23 of the 26 step
    files read `__MOCK_DB__` from sessionStorage (`grep -rln __MOCK_DB__ tests/e2e/steps`), some
    to seed and some to assert (for example `tests/e2e/steps/data_and_output.ts:165-171`). No lint
    rule or review check holds the line.
  - **6.5** `low` `executed` — Six `test.todo` entries in
    `tests/teamGeneration.characterization.test.js:170-175` describe incremental teaming that is
    now implemented and tested elsewhere (`tests/teamGenerationIncremental.test.js`,
    `tests/incrementalTeamingScenarios.test.js`); they report as permanently pending.
- **Pattern that closes the gap:** run `npm run test:coverage` in CI in place of `npm run test`;
  run pgTAP on every PR; delete or move the staging suite into a manual workflow that records its
  result; resolve the todos.

## 7. CI/CD

- **Current state:** one CI workflow (`.github/workflows/ci.yml`) on push to `main` and every PR:
  migration-version check, typecheck, lint, unit tests, frontend build, bundle budget, advisor
  lint, Playwright E2E (job `build-and-test`), and Deno mirror tests plus `deno check` (job
  `deno-mirror-tests`); on push to `main`, `deploy-migrations` (`supabase db push`, behind a
  guard) and `deploy-edge-functions`. The frontend deploys through Vercel's Git integration.
  `permissions: contents: read` at the workflow level. Actions are pinned by tag (`@v4`, `@v2`,
  `@v1`).
- **Findings:**
  - **7.1** `high` `executed` `core.settings-branch-protected` — Nothing requires CI to pass
    before a merge: `main` has no branch protection and no ruleset
    (`GET /repos/JoelA510/SquadLogic/branches/main` → `"protected": false`; `/rulesets` → `[]`).
    A push or merge to `main` runs `deploy-migrations` against production on the same push
    (after `build-and-test` passes), so an unreviewed change that passes CI migrates the
    production database with no review, and Vercel deploys the frontend from `main` whether CI
    passed or not. CLAUDE.md §3 ("CI must be green
    before merge") and `docs/operations/ci-cd.md` §"Branch Protection" ("`main` must be protected
    … Required checks should include the primary CI workflow, CodeQL, …") declare it; neither is
    enforced, and there is no CodeQL workflow to require.
  - **7.2** `high` `executed` `node.runtime-pinned` — CI runs Node 20, which reached end of life
    on 2026-04-30, while production builds on Node 24 by PR #332's own account; nothing pins a
    version (no `.nvmrc`, `.node-version`, `.tool-versions` or `mise.toml`), and `engines` is
    `>=20`. The fix has sat in PR #332 since 2026-06-16.
  - **7.3** `medium` `statically reviewed` — Vercel's build settings (Node version, build
    command, environment variables) live only in its dashboard; `vercel.json` holds rewrites and
    headers only. Vercel deploys `main` on push independently of CI. The rollback section of
    `docs/operations/ci-cd.md` covers workflow changes and migrations only; there is no written
    rollback for the frontend (Vercel's "Instant Rollback" or a redeploy of a previous build).
  - **7.4** `medium` `executed` `core.workflows-audited` — Workflows are not audited (no zizmor)
    and actions are pinned by mutable tag, not commit, in workflows that hold
    `SUPABASE_ACCESS_TOKEN` and the database password.
  - **7.5** `low` `executed` `node.ci-runs-gate` — `npm run build` (`node scripts/build.js`) is
    not a build: it imports six core modules and checks they are functions. CI runs the real
    build (`npm run frontend:build`), so the gap is the name: the standard fails because the
    script called `build` never runs in CI, and a contributor who runs `npm run build` gets no
    bundle.
- **Pattern that closes the gap:** a ruleset requiring `Build & Test` and `Deno Mirror Tests`
  (and pgTAP once it runs on every PR), imported from a file in the repository (skeleton:
  `prompts/skeletons/.github/rulesets/main.json`); `.nvmrc` with 24, `engines` `^24`, and
  `node-version-file: .nvmrc` in every `setup-node` (land PR #332); the Vercel settings written
  into `vercel.json` (`buildCommand`) and `engines`; a frontend rollback paragraph in
  `docs/operations/ci-cd.md`; zizmor in CI and commit-pinned actions; rename `build` to what it
  does.

## 8. Security

- **Current state:** secret scanning and private vulnerability reporting are on (settings pass);
  a scan of the tree and of the 273 commits fetched (since 2026-07-20) for JWTs, `sb_secret_`
  keys, AWS keys and private keys found nothing (executed; older history not fetched). CSP,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` are
  set in `vercel.json` (`vite-spa.security-headers`, audit: set in the repository; the deployed
  response was not fetched, production being out of bounds). Edge Functions share a rate
  limiter (`supabase/functions/_shared/rateLimit.ts`).
- **Findings:**
  - **8.1** `high` `executed` `node.audit-gate` (July DS-3, still open and grown) — `npm audit`
    reports 8 high and 6 moderate advisories, including `react-router` (a runtime dependency) and
    `vite`; none is waived, and the register `docs/security/dependabot-waivers.md` says "`npm
    audit` reports 0 vulnerabilities". No workflow runs a dependency audit, on PRs or on a
    schedule.
  - **8.2** `medium` `executed` `core.dependency-updates` — No `.github/dependabot.yml` or Renovate
    config, so version updates never arrive; Dependabot security PRs do (#331 is open,
    unreviewed).
  - **8.3** `medium` `executed` `node.install-guards` — No `.npmrc` (no release-age wait, git and
    remote-URL dependencies allowed by npm's defaults) and no `packageManager` pin, so a
    freshly published compromised release installs on the next `npm install`.
  - **8.4** `medium` `executed` `vite-spa.client-env` (the standard grades it high; regraded
    because no secret reaches the bundle today: every `VITE_` variable in the three env examples
    is public by design) — `frontend/src/config.js:7-8` reads `import.meta.env` as a whole, which
    makes Vite embed every `VITE_` variable at that point; `.env.test.example:11` names
    `VITE_TEST_PASSWORD`, which `mockSupabaseClient.js:2043` reads into the client bundle. The
    next secret given a `VITE_` name ships to every visitor without a warning.
  - **8.5** `medium` `executed` `core.security-policy` — No `SECURITY.md` (root, `.github/` or
    `docs/`), so a reporter isn't told that private reporting exists or what to expect.
  - **8.6** `medium` `executed` `supabase.advisors-in-ci` — CI runs the repository's regex
    approximation (`scripts/advisor-lint.js`) but never Supabase's own advisors
    (`supabase db advisors` / `db lint --fail-on`), which see the live catalog (an RLS policy
    re-evaluating `auth.uid()` per row, a view bypassing RLS, a function without `search_path`).
- **Pattern that closes the gap:** the dependency-policy skeleton (`prompts/skeletons/docs/dependency-policy.md`):
  an audit step that fails on high/critical in `ci.yml` plus a weekly schedule, a JSON waiver
  register with reasons and expiries, `.github/dependabot.yml` with a cooldown, `.npmrc` with
  `min-release-age`, `allow-git=none`, `allow-remote=none` and a pinned `packageManager`; a
  `SECURITY.md` (skeleton); `supabase db advisors --fail-on warn` after `supabase start` in the
  pgTAP job; the env module of 2.2 replacing the dynamic read, and the test password renamed off
  the `VITE_` prefix as `.env.test.example`'s own comment plans.

## 9. Observability

- **Current state:** `@sentry/react` initializes when `VITE_SENTRY_DSN` is set
  (`frontend/src/main.jsx:16-36`), with tracing and on-error replay; `logger.error` and
  `ErrorBoundary` forward to it; `docs/operations/sentry-smoke.md` is the runbook. Whether the
  DSN is set in production could not be checked (Vercel dashboard; production out of bounds).
  Edge Functions can ship logs to BetterStack through `supabase/functions/_shared/logtail.ts`.
- **Findings:**
  - **9.1** `high` `statically reviewed` `core.error-reporting` — "What failed for user X
    yesterday?" can't be answered: `logger.setUser` (`frontend/src/lib/logger.js:78-83`) is
    never called (`grep -rn "logger.setUser\|Sentry.setUser" frontend/src` finds only its
    definition), so no Sentry event carries a user or organization ID; and only one of the seven
    Edge Functions (`auto-scheduler`) imports the log shipper.
  - **9.2** `medium` `statically reviewed` — The CSP allows Sentry at `https://*.ingest.sentry.io`
    (`vercel.json`, `docs/security/csp.md:50`), a wildcard that matches exactly one label. DSNs
    issued for Sentry's regional ingest (`o<id>.ingest.us.sentry.io`, `.de.`) don't match it, so
    the browser would refuse every event with only a console warning. Whether production's DSN
    is regional is unverified.
- **Pattern that closes the gap:** call `logger.setUser({ id, organization_id })` on sign-in and
  organization switch (IDs, never names or emails), wire the log shipper into every Edge
  Function's error path, add the DSN's actual ingest host to `connect-src`, and run the smoke in
  `sentry-smoke.md` with an induced error, recording the event ID.

## 10. Performance

- **Current state:** measured (executed): `npm run check:bundle` passes; the largest gzipped
  chunks are `chart-vendor` 118.9 KB, `index` 118.1 KB, `supabase-vendor` 49.7 KB,
  `PracticeRepairPanel` 35.9 KB; the mock client is its own 25.5 KB chunk loaded only in mock
  mode. Page components are lazy-loaded. The budget is enforced in CI (`check:bundle` in
  `build-and-test`, under `set -o pipefail`).
- **Findings:** none. The scorecard's `vite-spa.bundle-budget` failure is refuted below: the
  budget exists and fails the run.
- **Pattern that closes the gap:** n/a.

## 11. Accessibility & UX completeness

- **Current state:** CLAUDE.md §3 ("Accessibility First") and §9 set WCAG 2.2 AA; the roster manager uses dnd-kit's
  keyboard sensor; one feature tests keyboard access to the auto-scheduler panel
  (`tests/e2e/features/auto_scheduler.feature`). Loading, empty and error states were not
  reviewed screen by screen (see Coverage and limitations).
- **Findings:**
  - **11.1** `high` `statically reviewed` (July DS-17, still open) — No automated accessibility
    check runs anywhere: no `eslint-plugin-jsx-a11y` in `eslint.config.js`, no axe in any test
    (`grep -rln "axe-core\|jsx-a11y" package.json eslint.config.js tests` finds nothing). The
    WCAG 2.2 AA bar is declared, not enforced.
  - **11.2** `high` `statically reviewed` (July DS-18, still open) — The game-scheduling grid is
    drag-only: `frontend/src/pages/GameSchedulingPage.jsx:1168` renders `<DndContext>` with no
    `sensors` (no keyboard sensor) and `GameCard` offers no "move to" control, so a keyboard or
    switch user can't reschedule a game (WCAG 2.2 SC 2.1.1 and 2.5.7). CLAUDE.md §9 requires a
    non-drag alternative in scheduling grids.
- **Pattern that closes the gap:** `eslint-plugin-jsx-a11y` in lint and an axe scan step in the
  E2E suite for every top-level route; the roster manager's sensor pattern plus a "Move to…"
  control on the game card.

## 12. Docs, operability & stated-rule conformance

- **Current state:** a large, current docs tree (`docs/README.md` index, ADR-like plans,
  runbooks for CI/CD, migrations, Sentry, storage retention), `docs/LESSONS_LEARNED.md`, and a
  CLAUDE.md that is the only agent instruction file. `.agents/skills/` holds three
  `squadlogic-*` skills (the path Codex, Antigravity, Cursor and Copilot read). Agent prompt
  packets live in `project-hardening/` (10 files).
- **Findings:**
  - **12.1** `high` `executed` `core.agent-rules` — Agent rules live only in `CLAUDE.md`, which
    only Claude Code reads. The repository also keeps skills in `.agents/skills/` (read by other
    agents) and its prompt packets direct Codex and Gemini review bots, so more than one agent
    works here and none of the others gets the rules.
  - **12.2** `medium` `executed` `core.instructions-resolve` — The three `squadlogic-*` skills
    (`.agents/skills/squadlogic-audit-trail-inspector/SKILL.md`,
    `squadlogic-evaluator-designer`, `squadlogic-feature-guardians`) have no YAML frontmatter, so
    no agent can discover or load them.
  - **12.3** `medium` `statically reviewed` — CLAUDE.md contradicts itself and the code:
    §3 "Refactor First: … refactor it into a clean utility/hook *before* adding new logic"
    against §3 "Minimal diffs … flag any refactor beyond the request before doing it"; §10's
    table marks `VITE_SUPABASE_URL` as committed in `.env` "(yes)" while the next line says
    "Never commit `.env`"; §10 documents `VITE_PERSISTENCE_ENDPOINT`, which no code reads (the
    code reads `VITE_SUPABASE_PERSISTENCE_URL`; July DD-6, still open); §8 says `.features-gen/`
    is generated and gitignored, while `.features-gen/tests/e2e/features/team_communication.feature.spec.js`
    is committed and `playwright.config.ts` writes to `.features-gen-local` instead.
  - **12.4** `medium` `statically reviewed` — Agent instructions kept in ordinary docs:
    `project-hardening/` holds a loop-controller prompt and nine numbered PR prompts. Its README
    says to place the bundle at `./hardening-plan/` and its controller says "Do not commit it",
    yet it is committed under another name, referenced by no other file, and names a model and
    merge authority ("The user has pre-authorized opening PRs and merging them") that no agent
    should pick up by accident. Neither the scorecard nor `check:instructions` reads it.
  - **12.5** `medium` `statically reviewed` — The July remediation plan has no status line and
    was never closed: at least seven of its items are still open at `565e980` (DS-2 → 2.3, DS-3 →
    8.1, DS-7 → 5.2, DS-17 → 11.1, DS-18 → 11.2, TG-1 → 6.1, DD-6 → 12.3), and nothing records
    which of its 38 findings were fixed.
  - **12.6** `medium` `executed` `core.license` — A public repository with no `LICENSE` file;
    README and `package.json` say ISC, but the grant isn't in the repository.
  - **12.7** `low` `executed` `core.lf-line-endings` — 13 tracked files are committed with CRLF
    or mixed line endings despite `.gitattributes` `* text=auto eol=lf`; six of them are applied
    migrations (`supabase/migrations/20240405180000_*`, `20260324000000_*`,
    `20260324000002_*`-`20260324000004_*`, `20260331000000_*`), which
    `scripts/ci/migrationVersions.mjs` forbids editing, so they can't simply be renormalized.
  - **12.8** `medium` `executed` `core.process-delivered` — At the audited commit the template's
    process was not in the repository. Resolved by this run's delivery commit `a63a9f8` (the
    scorecard passes it there).
  - **12.9** `low` `statically reviewed` — README's release line ("v1.0.1 (2026-04-23) shipped;
    the Lightning-class redesign has since merged to `main` (unreleased)") has not moved in six
    months of shipped work; the CHANGELOG's latest entry should be checked against it.
- **Pattern that closes the gap:** one `AGENTS.md` holding the rules every agent follows, with
  `CLAUDE.md` reduced to `@AGENTS.md` plus Claude-specific notes (D1), the contradictions
  resolved there; frontmatter on the three skills; the durable rules from `project-hardening/`
  merged into AGENTS.md and the packets removed (D8); a status line on the July plan that maps
  each item to closed or to this audit's ID; an ISC `LICENSE` (D7); `.gitattributes` marking the
  six applied CRLF migrations `-text` and renormalizing the rest.

## 13. Core flows

Exercised in the configuration the docs offer that can run here: mock mode
(`VITE_USE_MOCK_SUPABASE=true`, README "Mock mode", "how the E2E suite runs"). The real-Supabase
configuration needs either production (out of bounds) or a local stack (no Docker here), so no
flow was exercised against it. "Test through entry point" means the Vitest suite calling the
engine's real exported function; "E2E" means the Playwright-BDD scenario driving the built UI.

| Flow (as promised, with where) | How exercised | Result | Test that proves it |
| --- | --- | --- | --- |
| Sign in as admin, coach or parent; role-scoped navigation (README "Role-Based Access Control", "Role dashboards") | E2E, mock auth, every feature's Background; RBAC features | Works (mock) | `tests/e2e/features/visual_rbac_enforcement.feature`, `rbac_multi_tenancy.feature` |
| Create a first organization (onboarding) | E2E | Works (mock) | `tests/e2e/features/onboarding_cold_start.feature` |
| Season setup checklist / readiness (README "Season Setup") | E2E | Works (mock) | `tests/e2e/features/dashboard_workflow.feature` |
| Import GotSport players: column validation, row errors, buddy pairs (README "Durable CSV Import") | E2E through the real import UI (`setInputFiles`), plus Vitest | Works (mock) | `tests/e2e/features/ingestion_hardening.feature`, `tests/playerImportBuddyMaterialization.test.js` |
| Import coaches and field slots: apply, defer, roll back | E2E through the real import UI | Works (mock) | `tests/e2e/features/ingestion_hardening.feature` |
| Generate teams (README "Automated Team Generation") | Vitest through `generateTeams` and the incremental entry points, on the season-2026 corpus; the E2E scenario writes ten teams into the mock database itself | Works at the engine; the UI path is unproven | `tests/teamGenerationIncremental.test.js`, `tests/incrementalTeamingScenarios.test.js`; the E2E "Automated Team Generation" proves nothing (13.3) |
| Balance rosters by drag and drop (README "Team Builder") | E2E with pointer events | Works (mock) | `tests/e2e/features/Pillar2_CoachDailyLoop.feature` ("Drag-and-drop roster adjustments") |
| Schedule practices, auto-schedule, lock, apply (README "Practice & Game Scheduling Engines") | Vitest on the corpus; E2E apply through persistence on the mock; the Pillar 1 practice scenario writes a finished run itself | Works at the engine and through Apply (mock) | `tests/e2e/features/auto_scheduler.feature`, `practice_schedule_locking.feature`, 33 corpus test files |
| Fairness metrics and conflict detection on the practice page (README "Evaluation Pipeline") | Scratch probe rendering `EvaluationPanel` with the page's exact props (executed); page and engine read | **Broken**: evaluates an empty roster | none (every page test stubs the panel) — 13.1 |
| Generate a round-robin game schedule and resolve conflicts | Vitest; E2E drag-to-resolve on the mock; the Pillar 1 game scenario writes a finished run itself | Works at the engine; generation's UI path unproven | `tests/GameScheduleGrid.test.jsx`, `admin_overrides.feature`; "Game Schedule Generation" proves nothing (13.3) |
| Manage venues, fields, blackouts, retirements (README "Facility Management") | E2E | Works (mock) | `facility_management.feature`, `field_blackout_admin.feature`, `estate_retirement.feature` |
| Export rosters and schedules; coach welcome emails (README "/exports") | E2E | Works (mock; Storage upload is the mock's) | `output_operationalization.feature`, `reporting.feature` |
| Enter scores, see standings (README "Reporting") | E2E | Works (mock) | `reporting.feature` ("Coach enters a game score and standings update") |
| RSVPs and team messages (README "Communication") | E2E | Works (mock) | `team_communication.feature`, `team_portal_practice_changes.feature` |
| Calendar sync: ICS feed (README "Calendar Sync") | E2E copies the subscription link; the feed itself is an Edge Function (Deno, not available here) | Partial: link only | `calendar_sync.feature`; feed logic in `tests/calendarFeed.test.js` |
| Registration forms and compliance dashboard (README "Registration & Compliance") | E2E | Works (mock) | `registration_compliance.feature` |
| Organization isolation (README "Multi-Tenant Enforcement") | E2E against the mock (no RLS there); pgTAP not runnable here | Not proven here | pgTAP `supabase/tests/` in CI on `supabase/**` PRs only (3.1) |
| Feature toggles and gender model (README "Org feature configuration") | Vitest component tests | Works (component level) | `tests/FeatureFlagSettings.test.jsx`, `tests/divisions.test.js` |
| Every flow above against the real Supabase configuration | Not exercised: needs production (out of bounds) or a local stack (no Docker) | Unknown | none (13.2) |

- **Current state:** 19 rows: 18 promised flows and the real-backend configuration. In mock
  mode, 12 flows work end to end through the UI and 3 more at the engine or component level; one
  is broken (fairness evaluation), one is only partly exercised (the ICS feed), and
  organization isolation isn't proven here (the mock has no RLS). None was exercised against the
  real backend. Three
  E2E scenarios whose names promise the engine (team generation, practice scheduling, game
  scheduling) never run it.
- **Findings:**
  - **13.1** `blocker` `executed` (the panel's request) and `statically reviewed` (the page's
    props and the engine; known issue #364, confirmed at `565e980`) — The
    practice page's fairness evaluation reports a clean result after examining nothing.
    `frontend/src/pages/PracticeSchedulingPage.jsx:1312-1316` renders
    `<EvaluationPanel practiceData={{ assignments: localAssignments }} />`, and
    `frontend/src/components/EvaluationPanel.jsx:58-61` defaults `teams` and `slots` to `[]`, so
    `fairness-scoring` evaluates an empty roster and returns zero coach conflicts for every
    schedule. README promises "fairness metrics, and conflict detection"; an administrator
    reading the panel is told a schedule is conflict-free when nothing was checked. A scratch
    probe (not committed) rendered `EvaluationPanel` with exactly the page's props and recorded
    the `fairness-scoring` request: `practice.assignments` had 2 entries, `teams` and `slots`
    were `[]`; `supabase/functions/_shared/engines/scoring-engine.ts:79` builds its team lookup
    from `teams`, so no coach is ever found. No test renders the panel with the page's data:
    the four page tests that mount `PracticeSchedulingPage` all stub it
    (`vi.mock('../frontend/src/components/EvaluationPanel.jsx', …)`).
  - **13.2** `medium` `statically reviewed` — No flow is proven end to end against the real
    Supabase configuration: the E2E suite runs only on the mock (6.4), the staging suite never
    runs (6.2), and pgTAP covers the database alone. A flow can pass every gate and fail in
    production where the mock and the real RPCs differ.
  - **13.3** `high` `executed` (the scenarios pass) and `statically reviewed` (their steps) — The
    three Pillar 1 scenarios that name the engines can't fail.
    `tests/e2e/steps/scheduling_and_overrides.ts:242-270` ("I trigger the team generation
    algorithm") writes ten teams into `__MOCK_DB__` and the next step asserts ten teams;
    `:380-405` ("the scheduler runs") pushes a completed practice run with
    `double_bookings: 0, over_capacity: 0` and `:419-439` assert those zeros; the game scenario
    seeds `scheduledRate: 1.0` and `:514-525` asserts "100%" with the comment "The mock data sets
    scheduledRate to 1.0". Other steps under the same scenarios assert only that a card is
    visible (`:321-327`, "players should be balanced by skill level"). This is the shape CLAUDE.md
    §3 names: "A test that forges internal state the production path cannot reach is evidence of
    a bug, not coverage." The engines are proven by Vitest; the path from the UI to them is not.
- **Pattern that closes the gap:** pass the page's teams and slots, make "evaluated zero teams"
  a visible state rather than a zero, and add a test through the page that fails on today's
  wiring; then an E2E run against a local Supabase stack (the pgTAP job already starts one) for
  the import → teams → schedule → publish path.

## Conflicts

- Strictness: the template standard `node.strict-types` requires `strict`; CLAUDE.md §4
  declares `strict: false` as the project's choice. — controls: CLAUDE.md (the repository's
  stated rule outranks the template). The finding stands as a recorded gap, and raising
  strictness is a flagged refactor for the owner (D2), not milestone work.
- Agent rules home: the template's `process:apply` output says an existing project "merges the
  rules from `prompts/skeletons/AGENTS.skeleton.md` into CLAUDE.md", while its own standard
  `core.agent-rules` requires an `AGENTS.md` at the root. — controls: neither for this repo
  until the owner decides (D1); the default follows the standard, because more than one agent
  works here (12.1).
- Line endings: `core.lf-line-endings` says to renormalize every CRLF file; this repository's
  `scripts/ci/migrationVersions.mjs` forbids editing an applied migration. — controls: the
  repository's migration rule; the six migrations are excluded with `-text`, not rewritten.
- Process: CLAUDE.md §3 says "Run `/code-review` on every PR before opening it"; the delivered
  process adds `/pre-pr` and `/review-change`. — controls: CLAUDE.md; the delivered skills are
  offered, not mandated, until AGENTS.md says otherwise (D1).

## Refuted or corrected during verification

A second, adversarial pass re-read the cited files and line ranges at `565e980`, checked each
scorecard verdict against the files it names, and re-derived three results independently: RLS
presence (a grep over all 127 migrations), the settings verdicts (`GET /repos/…`,
`/branches/main`, `/rulesets`, `/private-vulnerability-reporting`), and the fairness defect (a
scratch probe). Gates were not re-run a second time.

- `vite-spa.bundle-budget` (scorecard: fail) — REFUTED — `.github/workflows/ci.yml` step
  "Bundle-budget gate (Wave 6a)" runs `npm run check:bundle | tee …` under `set -o pipefail`,
  and `scripts/check-bundle-size.js` reads `config/bundle-budget.json` and fails the run over
  budget (executed: PASS output above). The probe looks only for a script named
  `check-bundle-size.mjs`, `size-limit`, `bundlesize` or `bundlewatch`. No finding raised in §10.
- `node.ci-uses-pin` (scorecard: pass) — CORRECTED — it passes because CI's only `setup-node`
  names `20`, equal to the `engines` floor `>=20`, which the standard allows for a job that
  deliberately tests the oldest supported version. This job is the only Node job, and there is
  no pin to take a version from. The gap is carried by 7.2.
- `node.ci-runs-gate` (scorecard: fail on the build) — CORRECTED — CI does run the production
  build (`frontend:build`); what's wrong is that the script named `build` isn't one. Recorded as
  7.5 at low, not as a missing build gate. The scorecard's hint that the project "may live below
  the root (frontend)" does not apply: `frontend/` is a workspace directory without a
  `package.json`.
- `node.install-guards` — CORRECTED (evidence wording) — the scorecard says ".npmrc lets a
  dependency bring in a git dependency (allow-git=all)"; there is no `.npmrc` at all, and
  `allow-git=all` is npm's default. The verdict stands.
- `vite-spa.client-env` — CORRECTED (severity) — regraded from the standard's high to medium in
  8.4: no secret is in a `VITE_` variable today.
- Initial reading that 27 tables lacked RLS — REFUTED — a first single-line grep missed
  multi-line `alter table … enable row level security` statements; the multi-line re-check found
  an enable statement for all 57 tables, matching the scorecard.
- Initial suspicion that Vitest needs `NODE_OPTIONS=--no-experimental-webstorage` on Node ≥ 22
  (July baseline) — REFUTED — the suite passed on Node 24.21.0 without it.
- 5.1 — CORRECTED (evidence) — the first draft cited `frontend/src/config.js:33-38`; the guard
  spans lines 34-77 (condition at 34-38, throw at 71). Then reproduced locally (executed).
- 7.1 — CORRECTED (scope) — the first draft said a red change could migrate production;
  `deploy-migrations` `needs: [build-and-test]`, so only a change that passes CI does. The
  finding stands: nothing requires review or CI before the merge, and Vercel deploys regardless.
- 11 (current state) — CORRECTED — the WCAG 2.2 AA bar is in CLAUDE.md §3 and §9, not §5.
- July PB-1 to PB-4 — not re-raised: fixed by `20260726000000`-`20260726000300` (statically
  reviewed, and applied and smoke-tested by the harness, executed).

## Coverage and limitations

- Production and shared environments were not touched (owner constraint): no Supabase MCP
  tools, no `supabase db push`, no fetch of the deployed site. So the deployed headers, the
  Sentry DSN's presence and region, Vercel's dashboard settings, and the production database's
  advisors were not observed.
- Not run here: pgTAP and Supabase advisors (no Supabase CLI or Docker), Deno mirror tests and
  `deno check` (no Deno), the staging integration suite (no credentials, shared environment).
- The real-Supabase configuration of every core flow was not exercised; §13 covers mock mode
  and the engines' entry points only.
- Areas reviewed by sampling, statically: authorization was checked for RLS presence on every
  table and for the July blockers, not policy by policy; SECURITY DEFINER functions (190
  definitions, 123 `revoke … on function` statements) were not checked one by one for their
  `EXECUTE` grants; loading, empty and error states (§11) were not reviewed screen by screen;
  the July audit's 38 findings were re-checked only where named above.
- Git history was fetched back to 2026-07-20 (273 commits); older history was not scanned for
  secrets (secret scanning is on for the repository, which covers pushes since it was enabled).
- Repository settings for Dependabot alerts and the default workflow token were skipped: the
  session's token has no admin read.
