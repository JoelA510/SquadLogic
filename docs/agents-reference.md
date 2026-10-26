# Agent reference — SquadLogic

The detail `AGENTS.md` points to: read it when your task touches the area. The rules live in
`AGENTS.md`; this file is reference, moved out on 2026-10-14 so the file every agent loads at
launch stays short (Claude Code's guidance is about 200 lines per instruction file; longer files
load more context and are followed less consistently). Section numbers match `AGENTS.md`, so a
citation of "AGENTS.md §11" (or the older "CLAUDE.md §11") finds its detail here.

## 4. Architecture

### Layout (npm workspaces: `packages/*`)

- `frontend/src/` — the Vite + React 19 SPA (no `package.json` of its own): `components/`
  (subdirs `chrome/`, `grid/`, `scheduling/`, `setup/`, `teaming/`, `ui/`), `contexts/` (Auth,
  Import, Organization, Theme), `hooks/`, `layouts/`, `lib/` (`supabaseClient`,
  `mockSupabaseClient`, `logger`), `pages/`, `constants/`, `utils/`.
- `packages/core/src/` — `@squadlogic/core`, the shared domain logic (pure JS, NO React imports):
  scheduling engines, metrics, persistence, validation, team generation.
- `supabase/` — `functions/` (Edge Functions), `migrations/`, `seed.sql`.
- `tests/` — Vitest `*.test.{js,jsx}`, `e2e/` (features + steps), `factories/`, `helpers/`.
- `scripts/` (build and gate scripts), `docs/`, `.github/workflows/`.

> **Vite root is `frontend/`** — `vite.config.js` at project root sets `root: 'frontend'` and `envDir: '..'`. All frontend paths are relative to `frontend/`, but env files live in the project root.

### Key Technologies

React 19, Vite 7, react-router-dom v7; Tailwind CSS 4 (`@tailwindcss/vite`) plus a vanilla CSS
design system; React Context for state; Supabase (PostgreSQL, Edge Functions, Auth, Storage);
Vitest + @testing-library/react + jsdom; Playwright-BDD (Gherkin + TS steps); ESLint (flat
config) + Prettier, knip for unused code; TypeScript checkJs/allowJs, `strict: false`;
@dnd-kit; Recharts; lucide-react; Vercel (static SPA + rewrites, build settings in `vercel.json`).

### Path Aliases (vite.config.js + tsconfig.json)

`@`, `src` and `@squadlogic/core` all map to `packages/core/src/`. **Always use
`@squadlogic/core/...` for imports from the core package in frontend code.**

## 5. Coding Conventions

- **Prettier** (enforced by ESLint): semicolons, single quotes, trailing commas `es5`, print
  width 100, tab width 2.
- **Components** are **`.jsx`** (not `.tsx`; the project type-checks with `checkJs`/`allowJs`),
  functional with hooks only. Pages are lazy-loaded via `React.lazy()` in `App.jsx`; protected
  routes use `<ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>`. Provider
  order (canonical, `App.jsx`): `BrowserRouter` > `AuthProvider` > `OrganizationProvider` >
  `ImportProvider` > `ThemeProvider` > `ToastHost` > `ErrorBoundary` > `OfflineGuard`.
- **Where code goes:** domain logic in `packages/core/src/` (pure, framework-agnostic, no React
  imports); components in `frontend/src/components/` (feature subdirs such as `scheduling/`,
  `teaming/`, `ui/`); hooks (`use…`) in `frontend/src/hooks/`; pages in `frontend/src/pages/`;
  contexts in `frontend/src/contexts/`; Edge Functions in `supabase/functions/<name>/index.ts`.
- **RBAC:** roles `admin`, `coach`, `staff` (and `tenant_admin`; no `parent` or `player` since
  `20261024010000`); `staff` are
  admins, as `ADMIN_ROLES` in `frontend/src/constants/permissions.js` says and `is_org_admin()` and
  the Edge `verifyOrgAdmin` agree (`tests/adminRolesParity.test.js`); permissions in
  `frontend/src/constants/permissions.js`, enforced by the `usePermission` hook and
  `<ProtectedRoute>`. A coach holds no scheduling permission since `20261028010000` (R6): their
  schedule is on their home, and score entry and standings are admin functions behind the
  `score_entry` and `standings` settings (off by default).

## 6. Design System — "Lightning-class" (Light + Dark)

Tokens in `frontend/src/index.css`, component classes in `frontend/src/styles/`. A **cobalt light
theme (default) and a dark theme**, toggled by `data-theme="dark"` on `<html>` from
`ThemeContext.themeMode` (stored as `sl-theme`). Self-hosted **Public Sans** (CSP is
`font-src 'self'`: never load remote fonts).

- **Prototype tokens** (source of truth, on `:root`, overridden by the dark block): `--bg-*`,
  `--border*`, `--text-*`, `--primary*`, status (`--success*`, `--warning*`, `--danger*`),
  `--accent-*`, `--ring`, `--shadow-*`, radii `--r-*`, layout metrics (`--topbar-h`, `--nav-w`,
  `--row-h`). **Legacy aliases** (`--color-*`, `--shadow-soft`, …) point at them, so older
  components and Tailwind utilities (`bg-bg-surface`, …) re-theme automatically.
- **Prefer the component classes** in `styles/chrome.css`, `styles/grid.css` and
  `styles/page.css` (`.btn` variants, `.badge`, `.chip`, `.card`, `.kpi`, form fields, `.empty`)
  and the primitives in `frontend/src/components/ui/` (`Button`, `Badge`, `Modal`, `Dropdown`,
  `Toggle`, `Tabs`, `Avatar`, `ToastHost`/`useToast`, `Tooltip`, `ProgressBar`, `FeatureGuard`)
  over custom styles.

**Do NOT hardcode color values or inline style overrides** — use tokens, and verify every
surface in both themes. New colors go into `index.css` (light **and** dark blocks).

## 7. Supabase & Mock Client

- **Real mode**: `@supabase/supabase-js` with credentials from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
- **Mock mode**: when built with `VITE_USE_MOCK_SUPABASE=true`, or in the dev server when the
  credentials are missing (a production build without them shows a Configuration Error instead;
  `docs/operations/ENVIRONMENT.md`). Uses `frontend/src/lib/mockSupabaseClient.js` — a
  **sessionStorage-backed** in-memory mock that simulates `.from()`, `.select()`, `.insert()`, `.auth`, etc.
- **All code imports from `frontend/src/lib/supabaseClient.js`** — never import the mock or `@supabase/supabase-js` directly.
- **Edge Functions** live in `supabase/functions/`, one directory with an `index.ts` each; shared
  utilities in `supabase/functions/_shared/`. They must respect `config/bundle-budget.json` and
  the `check:advisors` regex gate.

## 8. Testing

- **Vitest:** `npm run test` (`vitest.config.js`: jsdom, setup `tests/setup.js`), files
  `tests/*.test.{js,jsx}`. Coverage of `packages/core/src/**` and `frontend/src/hooks/**`, enforced
  in CI: 90/81/92/91 (statements/branches/functions/lines), hooks 62/52/64/66. Import
  factories and helpers through their barrels: `import { makeOrganization } from '../factories/index.js';`
- **E2E (Playwright-BDD):** `npm run test:e2e` (`bddgen && playwright test`;
  `playwright.config.ts`); features `tests/e2e/features/**/*.feature`, steps
  `tests/e2e/steps/**/*.ts`; generated specs in `.features-gen-local/` (gitignored; never commit
  them). It starts the Vite dev server on port 5173 with `VITE_USE_MOCK_SUPABASE=true`; Chromium
  only; CI runs `--workers=1` for mock isolation.

## 10. Environment Variables

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — the Supabase project URL and publishable
  (anon) key: `.env.local` (from `.env.example`) and Vercel.
- `VITE_USE_MOCK_SUPABASE` — force the mock client (`true`): `.env.local` or CI.
- `VITE_SUPABASE_PERSISTENCE_URL` — the Edge Function base URL, optional.
- `VITE_SENTRY_DSN` — the frontend Sentry DSN, optional: Vercel.
- `VITE_DEMO_ENABLED`, `VITE_OFFICIAL_SITE_URL`, `VITE_TURNSTILE_SITE_KEY` — demo mode, all optional:
  `true` shows the demo's entry point; the official deployment's URL (set on that project only);
  the public Turnstile site key. `docs/operations/ENVIRONMENT.md`, `self-hosting.md`.
- `TEST_ADMIN_EMAIL`, `TEST_COACH_EMAIL`, `TEST_PASSWORD` — E2E test
  accounts: `.env.test`.

Only `frontend/src/env.js` reads `import.meta.env`, by name; a production build fails on a missing
or malformed variable. **Never commit** `.env`, `.env.local`, or `.env.test`. The full reference
is `docs/operations/ENVIRONMENT.md`.

## 11. CI Pipeline

`.github/workflows/ci.yml`, job **Build & Test**: `npm ci` on the Node `.nvmrc` pins (24) →
`typecheck` → `lint` → `check:unused` → `test:coverage`, `test:perf` → `build` →
`check:bundle` → `check:advisors` → Playwright Chromium → `test:e2e -- --workers=1`, plus
`scripts/ci/migrationVersions.mjs` (well-formed, unique migration versions; on a PR, every added
migration above the base branch's latest, and no existing one renamed, edited or removed).
Job **Deno Mirror Tests**: `scripts/deno-mirror-tests.sh` (the Deno twins of core logic, two host
time zones) and `scripts/deno-check-edge.sh` (`deno check` on every Edge entrypoint, failing on
zero found). Both jobs are required to merge, as are `pgtap.yml`'s pgTAP job (the suites plus
Supabase's advisors, every PR), `audit.yml`'s `check:audit` (PRs, pushes, weekly),
`workflow-audit.yml`'s zizmor job and `e2e-real-backend.yml`'s real-backend E2E.
`dbharness.yml` runs the migration harness on PRs touching SQL. `workflow-audit.yml` runs zizmor
on PRs; every action is pinned by SHA (`docs/operations/ci-cd.md`).

On **push to `main`** only: `deploy-migrations` (environment `production`; `supabase db push`
behind `scripts/ci/migrationGuard.mjs`; reverts are never automatic), then
`deploy-edge-functions`. Both skip with a `::warning::` when their secrets are missing.
**CI is the only writer of migrations:** never apply a repo migration by hand or through MCP
`apply_migration`. A weekly keep-alive pings Supabase. Vercel deploys the frontend on its own
(`main` to production; other branches to a preview, except `claude/**` and `dependabot/**`,
which deploy only on request: `vercel.json` `git.deploymentEnabled`). Runbook, Vercel settings and rollback:
`docs/operations/ci-cd.md`; the 2026-09-28 ledger fix:
`docs/operations/migration-ledger-normalisation.md`.

## 12. Common Commands

- `npm ci` — install exactly what `package-lock.json` pins (cloud agents: first).
- `npm run frontend:dev` / `build` — Vite dev server (port 5173) / build to `dist/` (`build` runs
  `frontend:build`, which Vercel's `buildCommand` names).
- `npm run test` / `test:watch` / `test:coverage` — Vitest once / watch / with coverage.
- `npm run test:e2e` / `test:e2e:ui` — `bddgen` + Playwright / its interactive debug UI.
- `npm run lint` / `lint:fix` / `typecheck` — ESLint / auto-fix / `tsc --noEmit`.
- `npm run format` — Prettier on every file; prefer `npx prettier --write <your files>` (rule 2).
- `npm run check:bundle` / `check:advisors` / `check:unused` — bundle budget / advisor lint /
  knip (`knip.jsonc`). The bundle budget needs a build made as CI makes it, with stand-in
  Supabase and Sentry variables: the command is in `docs/operations/bundle-budget.md`.
- `npm run check:audit` — dependency audit gate (high/critical advisories, waivers).

## 13. Key Documentation Reference

Index: [`docs/README.md`](docs/README.md). Most used: `docs/LESSONS_LEARNED.md`,
`docs/architecture/system-overview.md`, `docs/architecture/multi_tenancy.md`,
`docs/security/rls-policies.md`, `docs/governance/governance-framework.md`,
`docs/operations/ENVIRONMENT.md`, `docs/operations/ci-cd.md`, `docs/testing/e2e_master_plan.md`,
`docs/expansion/03_ROADMAP.md`.
