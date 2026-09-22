# CLAUDE.md — SquadLogic Project Instructions

## 1. Role and Scope

You are an **Autonomous Developer** working on SquadLogic — proficient across the full stack: React frontend, Node.js domain logic, Supabase (PostgreSQL, Edge Functions, RLS policies), and CI/CD.

SquadLogic is a youth sports administration platform that converts raw GotSport registration data into teaming and scheduling frameworks. It is a feature-complete v1.0 MVP deployed on Vercel with a Supabase (PostgreSQL) backend.

---

## 2. Scope Guardrails (Hard Exclusions)

The following are **STRICTLY OUT OF SCOPE** — refuse to implement these even if asked:

1. **Website/CMS/Public Site Generation** — no hosting, website builders, or public club sites.
2. **Billing/Payment Collection** — no collecting money from players/families (SaaS billing display OK).
3. **Sensitive Document Storage** — no file uploads for waivers, IDs, birth certs (boolean toggles OK).
4. **Online Store/Merch** — no e-commerce.
5. **Sponsor Management** — no sponsor CRM.
6. **AI Assistants/Chatbots** — no integrated AI copilots (simple algorithmic automation is fine).
7. **Payment Processing** — no payment-related code or UI for end-users.

**Privacy & Data Rules:**

- **Data Minimization**: Only store PII necessary for scheduling/comms (Name, Email, Role, Team).
- **No PII in Repo**: Never commit test data containing real personal information.
- **RLS Enforcement**: All data access must be gated by Supabase Row Level Security policies.
- **Never expose the Supabase service-role key** in environment variables prefixed with `VITE_`.

---

## 3. Agent Workflow & Execution

Within any work unit:

1. **Read the relevant plan / spec and the affected docs** before editing — start with [`docs/LESSONS_LEARNED.md`](docs/LESSONS_LEARNED.md) if it covers your decision.
2. **Cut a feature branch** (`feat/...`, `fix/...`, `docs/...`).
3. **Implement → Verify → Commit → Push → PR**. CI must be green before merge.

### Working conventions (scheduling engine work)

- Minimal diffs. Match existing stack and conventions; flag any refactor beyond
  the request before doing it. Never reformat code you aren't changing.
- Plan before implementing on any task that touches the solver, the domain
  model, or persistence. Show the plan and wait for approval.
- Distinguish "statically reviewed", "executed", and "test-verified" in every
  report. Never claim tests passed without running them.
- Run the full fixture suite (`fixtures/season-2026/`) after any change to domain
  types, constraints, or solver stages. A change that breaks the season fixture
  is presumed wrong until shown otherwise.
- Validators must prove they exercised data (meta-assertions). A check that
  matches zero records is a loud failure, never a silent pass.
- Solver changes default to maximum freeze / minimal diff against the current
  schedule. Global re-optimisation only when explicitly requested by name.
- Never silently drop an unplaceable fixture; surface it as TIME TBD with a
  reason.
- Incident background for all of the above: [`fixtures/season-2026/README.md`](fixtures/season-2026/README.md).

### Verification conventions (learned from Phase 0-3 reviews)

Twenty-six defects reached `main` across Phases 1-3 and were caught only by an
adversarial post-merge review. Not one was a broken feature; every one was a
*hollow guarantee* that passed its own tests. The recurring shapes, so they are
recognised rather than rediscovered:

- **A meta-assertion you cannot make fail is not a meta-assertion.** For every
  coverage or exercise assertion you write, construct the case that makes it
  fail and prove it. The Phase 2 review found the flagship "examined every
  division" check deriving its universe from the same filter the rule applied --
  it compared a set against itself.
- **Never derive a check's subject set from the data a break would corrupt.**
  Teams were enumerated from the games, so a team dropped by a rename played
  zero of nine and was silently absent rather than reported. Enumerate from the
  roster, the registry, or whatever a break would leave intact.
- **A test that forges internal state the production path cannot reach is
  evidence of a bug, not coverage.** `TEAM_UNCOACHED` had a passing test that
  hand-built a state the real code could never produce -- because the real code
  was dropping the team's fixtures instead.
- **Never leave a field parsed and unread.** Honour it or delete it. A field
  that reads as load-bearing and is not is how the board waiver was lost.
- **When a sibling function already handles an edge case, adopt its contract
  rather than inventing a third one.** Several defects were one path filtering
  correctly while its neighbour did not.
- **Declared is not enforced.** A constraint with no evaluator, a rule with no
  registry claim, and a policy nothing optimises toward must each say so. An
  engine reporting "all constraints pass" while most cannot be checked is the
  same falsely perfect result in a larger disguise.
- **No raw control characters in source.** `tests/sourceHygiene.test.js`
  enforces this; use `\u0000`-style escapes. Raw NUL bytes once made a 57 KB
  file merge as an opaque binary blob whose diff nobody could read.
- **Run `/code-review` on every PR before opening it**, and fix the findings in
  that same PR. Reviewing per-milestone left defects sitting in `main` between
  phases.

### Core principles (apply within every PR)

- **Refactor First**: If a PR requires modifying existing messy code, refactor it into a clean utility/hook _before_ adding new logic.
- **Test-Driven**: Create the test file `tests/<feature>.test.js` _before_ or _during_ implementation.
- **RPC Enforcement**: Dedicated RPCs are mandatory for all state persistence; direct table `upsert` is discouraged for sensitive domain state.
- **Schema Rigidity**: All data updates must be governed by Zod schema validation to ensure platform integrity.
- **Audit Immutability**: All administrative or state-altering actions must be captured in the `audit_log` with full metadata.
- **Accessibility First**: WCAG 2.2 AA conformance is a core requirement; use screen-reader-friendly semantic HTML and focus management.
- **No Broken Main**: Never leave the `main` branch in a broken state.
- **Blocker Handling**: If a hard blocker (missing secret, impassable error) occurs, surface it to the operator (PR comment or GitHub issue) and stop.

### Definition of Done (Per PR)

- [ ] Types check (`npm run typecheck`).
- [ ] Tests pass (`npm run test` — Unit + Integration). _(E2E runs separately in CI/bulk.)_
- [ ] Linter is happy (`npm run lint`).
- [ ] Frontend build is clean (`npm run frontend:build`).
- [ ] `npm run check:advisors` and `npm run check:bundle` both green.
- [ ] New exports are registered in their package/module index.
- [ ] Database migrations applied (if any) with matching revert + smoke scripts under `docs/sql/`.

---

## 4. Architecture

### Monorepo Structure (npm Workspaces)

```text
SquadLogic/
├── frontend/           # Vite + React 19 SPA
│   └── src/
│       ├── components/ # UI components (flat + subdirs: chrome/, grid/, scheduling/, setup/, teaming/, ui/)
│       ├── contexts/   # React Contexts (Auth, Import, Organization, Theme)
│       ├── hooks/      # Custom hooks (useConflicts, useDashboardData, etc.)
│       ├── layouts/    # Layout wrappers (DashboardLayout)
│       ├── lib/        # supabaseClient, mockSupabaseClient, logger, apiClient
│       ├── pages/      # Route-level page components
│       ├── constants/  # App constants (permissions, roadmap)
│       └── utils/      # Frontend utilities
├── packages/core/      # @squadlogic/core — shared domain logic (pure JS, NO React imports)
│   └── src/            # Scheduling engines, metrics, persistence, validation, team generation
├── supabase/           # Edge Functions + migrations + seed.sql
│   ├── functions/      # Edge Functions (calendar-feed, game-persistence, etc.)
│   └── migrations/     # SQL migrations
├── tests/              # All tests (unit, integration, e2e)
│   ├── e2e/            # Playwright-BDD tests (features/ + steps/)
│   ├── factories/      # Shared test factories
│   ├── helpers/        # Shared test helpers
│   └── *.test.{js,jsx} # Vitest unit/integration tests
├── scripts/            # Build and utility scripts (incl. check:bundle, check:advisors)
├── docs/               # Architecture, operations, governance, security, testing, UI/UX, roadmap
└── .github/workflows/  # CI pipeline (ci.yml)
```

> **⚠️ Vite root is `frontend/`** — `vite.config.js` at project root sets `root: 'frontend'` and `envDir: '..'`. All frontend paths are relative to `frontend/`, but env files live in the project root.

### Key Technologies

| Layer         | Technology                                                              |
| ------------- | ----------------------------------------------------------------------- |
| Frontend      | React 19, Vite 7, react-router-dom v7                                   |
| Styling       | Tailwind CSS 4 (`@tailwindcss/vite` plugin) + Vanilla CSS design system |
| State         | React Context (Auth, Import, Organization, Theme)                       |
| Backend       | Supabase (PostgreSQL, Edge Functions, Auth, Storage)                    |
| Unit Testing  | Vitest + @testing-library/react + jsdom                                 |
| E2E Testing   | Playwright-BDD (Gherkin features + TS step defs)                        |
| Linting       | ESLint (flat config) + Prettier                                         |
| Type Checking | TypeScript (checkJs + allowJs, strict: false)                           |
| Drag & Drop   | @dnd-kit/core + @dnd-kit/sortable                                       |
| Charts        | Recharts                                                                |
| Icons         | lucide-react                                                            |
| Deployment    | Vercel (static SPA + rewrites)                                          |

### Path Aliases (vite.config.js + tsconfig.json)

- `@` → `packages/core/src/`
- `src` → `packages/core/src/`
- `@squadlogic/core` → `packages/core/src/`

**Always use `@squadlogic/core/...` for imports from the core package in frontend code.**

---

## 5. Coding Conventions

### Formatting (Prettier — enforced by ESLint)

- Semicolons: **yes** · Quotes: **single** · Trailing commas: **es5**
- Print width: **100** · Tab width: **2**

### Component Patterns

- Components are **`.jsx`** files (not `.tsx`) — the project uses `checkJs`/`allowJs` for type checking.
- Use **functional components** with hooks exclusively.
- Pages are lazy-loaded via `React.lazy()` in `App.jsx`.
- Protected routes use `<ProtectedRoute requiredPermission={PERMISSIONS.MANAGE_ORGANIZATION}>`.
- Provider wrapping order (canonical — see `App.jsx`): `BrowserRouter > AuthProvider > OrganizationProvider > ImportProvider > ThemeProvider > ToastHost > ErrorBoundary > OfflineGuard`.

### File Organization Rules

- **Domain logic** → `packages/core/src/` — must remain pure and framework-agnostic (no React imports).
- **React components** → `frontend/src/components/` — use subdirs for feature groupings (`scheduling/`, `teaming/`, `ui/`).
- **Custom hooks** → `frontend/src/hooks/` — prefixed with `use`.
- **Page components** → `frontend/src/pages/`.
- **Contexts** → `frontend/src/contexts/`.
- **Supabase Edge Functions** → `supabase/functions/<function-name>/index.ts`.

### RBAC System

Roles: `admin`, `coach`, `player`, `parent`, `staff`.
Permissions are defined in `frontend/src/constants/permissions.js` and enforced via the `usePermission` hook and `<ProtectedRoute>`.

---

## 6. Design System — "Lightning-class" (Light + Dark)

Defined in `frontend/src/index.css` (tokens) plus `frontend/src/styles/{chrome,grid,page}.css`
(component classes). The app ships a **cobalt light theme (default) and a dark theme**
toggled via `data-theme="dark"` on `<html>`, driven by `ThemeContext.themeMode`
(persisted to localStorage as `sl-theme`). The typeface is self-hosted **Public Sans**
(variable woff2; CSP is `font-src 'self'` so never load remote fonts).

### Token namespaces

Two namespaces coexist on `:root`; the dark block overrides only the prototype names:

- **Prototype tokens (source of truth)**: `--bg-app/--bg-shell/--bg-surface/--bg-sunken/--bg-hover/--bg-selected`,
  `--border/--border-soft/--border-strong/--border-field`, `--text-primary/--text-secondary/--text-muted`,
  `--primary/--primary-hover/--primary-weak/--primary-text`, status (`--success*/--warning*/--danger*/--neutral-weak`),
  accents (`--accent-teal/violet/amber/rose/green`), `--ring`, `--shadow-xs…--shadow-pop`,
  radii `--r-xs…--r-full`, layout metrics (`--topbar-h`, `--nav-w`, `--row-h`).
- **Legacy aliases** (`--color-bg-app`, `--color-text-primary`, `--color-status-*`, `--shadow-soft`, …)
  point at the prototype tokens so pre-redesign components and Tailwind utilities
  (`bg-bg-surface`, `text-text-primary`, …) re-theme automatically.

### Component classes (always prefer these over custom styles)

- Chrome (`styles/chrome.css`): `.app`/`.topbar`/`.nav*` shell, `.menu`/`.popover`, `.modal`/`.overlay`, `.toast`, `.avatar`, `.icon-btn`, `.role-banner`
- Grid (`styles/grid.css`): `table.grid`, `.grid-toolbar/.grid-selbar/.grid-foot`, `.cell`, `.cbx`
- Page (`styles/page.css`): `.page-head/.page-tabs/.page-body`, `.btn` (+`-primary/-default/-subtle/-danger/-ghost-danger`, `.sm/.lg`), `.badge`, `.chip`, `.card`, `.kpi`, `.field/.input/.select/.textarea/.toggle/.seg`, `.empty`, `.setup-step`, `.rf*` record fields, `.balance-*`/`.pchip`
- UI primitives (`frontend/src/components/ui/`): `Button`, `Badge`, `Modal`, `Dropdown`, `Toggle`, `Tabs`, `Avatar`, `ToastHost` (+`useToast`), `Tooltip`, `ProgressBar`, `FeatureGuard`
- Legacy utilities (`.glass-panel*`, `.card-glass`, `.glass-button*`, `.glass-input`, `.text-*`, `.animate-*`) are retained for compatibility and render flat in both themes

**Do NOT hardcode color values or inline style overrides** — use tokens, and verify every
surface in both themes. New colors go into `index.css` (light **and** dark blocks).

---

## 7. Supabase & Mock Client

### Environment Switching

The app auto-switches between real and mock Supabase clients:

- **Real mode**: Uses `@supabase/supabase-js` with credentials from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
- **Mock mode**: Activates when `VITE_USE_MOCK_SUPABASE=true` or credentials are missing. Uses `frontend/src/lib/mockSupabaseClient.js` — a **sessionStorage-backed** in-memory mock that simulates `.from()`, `.select()`, `.insert()`, `.auth`, etc.

**All code imports from `frontend/src/lib/supabaseClient.js`** — never import the mock or `@supabase/supabase-js` directly.

### Edge Functions

Located in `supabase/functions/`. Each function has its own directory with an `index.ts`. Shared utilities live in `supabase/functions/_shared/`. Edge Functions must respect `config/bundle-budget.json` and the `check:advisors` regex gate.

---

## 8. Testing

### Unit & Integration Tests (Vitest)

- **Command**: `npm run test` (or `npm run test:watch`)
- **Config**: `vitest.config.js` — environment: jsdom, setup: `tests/setup.js`
- **Location**: `tests/*.test.{js,jsx}` (e2e excluded)
- **Coverage thresholds**: statements 60%, branches 50%, functions 55%, lines 60%
- **Coverage scope**: `packages/core/src/**` and `frontend/src/hooks/**`
- **Factories + helpers**: `tests/factories/**` and `tests/helpers/**`. Import factories via the barrel: `import { makeOrganization } from '../factories/index.js';`

### E2E Tests (Playwright-BDD)

- **Command**: `npm run test:e2e` (runs `bddgen && playwright test`)
- **Config**: `playwright.config.ts`
- **Features**: `tests/e2e/features/**/*.feature` (Gherkin syntax)
- **Step Definitions**: `tests/e2e/steps/**/*.ts` (TypeScript)
- **Generated specs**: `.features-gen/` (gitignored, auto-generated by `bddgen`)
- **Web server**: Auto-starts Vite dev server on port 5173 with `VITE_USE_MOCK_SUPABASE=true`
- **Browser**: Chromium only
- **Workers**: 50% locally, 100% in CI (but CI runs with `--workers=1` for mock isolation)

### E2E Rules That Prevent Flaky Tests

1. **Always include `organization_id`** in mock data injections — React hooks filter by active org, causing empty states if omitted.
2. **Use DOM-based assertions only** — never assert on mock internal state or sessionStorage directly.
3. **Wait for hydration** — always use `expect(locator).toBeVisible()` or `page.waitForSelector()` before interacting with elements. React lazy-loading causes race conditions.
4. **Worker isolation** — CI runs with `--workers=1` to prevent sessionStorage cross-contamination between parallel workers.
5. **After changing `.feature` files**, always run `bddgen` to regenerate specs before running tests.
6. **Debugging failures**: Check `__MOCK_DB__` key in `sessionStorage` via Browser DevTools to inspect seeded data.

### Verification Sequence (before committing)

```bash
npm run lint              # 0 errors; warnings ≤ baseline
npm run typecheck         # 0 errors
npm run test              # 100% pass; case count matches expectation
npm run frontend:build    # clean
npm run check:advisors
npm run check:bundle
```

---

## 9. UI/UX & Accessibility Guidelines

When asked to perform a "UI/UX pass", "visual polish", or work on frontend views, follow the Agent UI/UX Guidelines:

1. **Reference the docs**:
   - **Agent guidelines**: `docs/ui/agent-ui-ux-guidelines.md` (canonical behavior rules for UI/UX work)
   - **P0/P1 checklist**: `docs/ui/ui-ux-pass.md`
   - **P2 visual polish**: `docs/ui/ui-ux-polish.md`
   - **Rule IDs**: `docs/ui/ui-ux-rules.json`
2. **Prioritization**: Always fix P0 and P1 issues before applying P2 visual polish.
3. **Accessibility (WCAG 2.2 AA)**:
   - Ensure all interactive elements are keyboard accessible and have visible focus indicators.
   - Maintain sufficient color contrast.
   - Provide non-drag alternatives for drag-and-drop interactions in scheduling grids.
4. **Semantic HTML**: Use proper landmarks (`<header>`, `<main>`, `<nav>`, `<section>`, `<article>`, `<footer>`).
5. **Design system alignment**: Reuse existing CSS classes and variables from `App.css` and `index.css`. Do not introduce new colors, spacings, or radii when equivalent tokens already exist.

---

## 10. Environment Variables

| Variable                    | Purpose                             | Committed?        |
| --------------------------- | ----------------------------------- | ----------------- |
| `VITE_SUPABASE_URL`         | Supabase project URL                | `.env` (yes)      |
| `VITE_SUPABASE_ANON_KEY`    | Supabase publishable (anon) key     | `.env.local` (no) |
| `VITE_USE_MOCK_SUPABASE`    | Force mock Supabase client (`true`) | `.env.local` / CI |
| `VITE_PERSISTENCE_ENDPOINT` | Custom persistence API endpoint     | `.env.local` (no) |
| `VITE_SENTRY_DSN`           | Frontend Sentry DSN                 | Vercel env (no)   |
| `TEST_ADMIN_EMAIL`          | E2E admin test email                | `.env.test` (no)  |
| `TEST_COACH_EMAIL`          | E2E coach test email                | `.env.test` (no)  |
| `TEST_PARENT_EMAIL`         | E2E parent test email               | `.env.test` (no)  |
| `TEST_PASSWORD`             | E2E test password                   | `.env.test` (no)  |

**Never commit** `.env`, `.env.local`, or `.env.test` — they are gitignored. Use the `.example` templates.

---

## 11. CI Pipeline

GitHub Actions (`.github/workflows/ci.yml`):

1. Checkout → Node 24 setup → `npm install`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test`
5. `npm run frontend:build`
6. `npm run check:bundle` (bundle-budget gate)
7. `npm run check:advisors` (static advisor gate)
8. Install Playwright Chromium → `npm run test:e2e -- --workers=1`

Plus a **weekly keepalive** cron job (Monday noon UTC) that pings the Supabase REST API to prevent free-tier project pausing.

---

## 12. Common Commands

| Command                  | Description                               |
| ------------------------ | ----------------------------------------- |
| `npm run frontend:dev`   | Start Vite dev server (port 5173)         |
| `npm run frontend:build` | Production build → `dist/`                |
| `npm run test`           | Vitest unit/integration tests             |
| `npm run test:watch`     | Vitest in watch mode                      |
| `npm run test:coverage`  | Vitest with coverage report               |
| `npm run test:e2e`       | `bddgen` + Playwright E2E suite           |
| `npm run test:e2e:ui`    | Playwright with interactive debug UI      |
| `npm run typecheck`      | TypeScript type checking (`tsc --noEmit`) |
| `npm run lint`           | ESLint check                              |
| `npm run lint:fix`       | ESLint auto-fix                           |
| `npm run format`         | Prettier format all files                 |
| `npm run check:bundle`   | Bundle-budget gate                        |
| `npm run check:advisors` | Advisor-lint static gate                  |

---

## 13. Key Documentation Reference

| Document                | Path                                             |
| ----------------------- | ------------------------------------------------ |
| **Documentation Index** | `docs/README.md`                                 |
| Architecture overview   | `docs/architecture/system-overview.md`           |
| Frontend architecture   | `docs/architecture/frontend-architecture.md`     |
| Data modeling           | `docs/architecture/data-modeling.md`             |
| Output Generation       | `docs/architecture/output-generation.md`         |
| Multi-tenancy           | `docs/architecture/multi_tenancy.md`             |
| Governance Framework    | `docs/governance/governance-framework.md`        |
| Lessons Learned         | `docs/LESSONS_LEARNED.md`                        |
| RLS policies            | `docs/security/rls-policies.md`                  |
| CSP policy              | `docs/security/csp.md`                           |
| Dependabot waivers      | `docs/security/dependabot-waivers.md`            |
| Advisor lint            | `docs/operations/advisor-lint.md`                |
| Bundle budget           | `docs/operations/bundle-budget.md`               |
| Production cutover      | `docs/operations/production-cutover.md`          |
| Sentry smoke            | `docs/operations/sentry-smoke.md`                |
| E2E master plan         | `docs/testing/e2e_master_plan.md`                |
| Roadmap                 | `docs/expansion/03_ROADMAP.md`                   |
| v1.1 planning           | `docs/expansion/v1.1-planning.md`                |
| UI/UX agent guidelines  | `docs/ui/agent-ui-ux-guidelines.md`              |
| UI/UX checklist         | `docs/ui/ui-ux-pass.md`                          |
| UI/UX polish guide      | `docs/ui/ui-ux-polish.md`                        |
