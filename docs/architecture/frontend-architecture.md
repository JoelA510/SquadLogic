[← Back to Documentation Index](docs/README.md)
---

# Front-End Architecture

This document describes the implemented frontend architecture for SquadLogic. The frontend is a React 19 Single-Page Application built with Vite 7, deployed as a static bundle on Vercel.

## Routing & Navigation

- **Router**: `react-router-dom` v7 with `<BrowserRouter>`.
- **Layout**: `DashboardLayout` renders the Lightning-class shell — `chrome/TopBar.jsx` (org/season switchers, search, theme toggle, role preview) and the nested collapsible `chrome/SideNav.jsx` (mobile off-canvas drawer) driven by `constants/navigation.js`.
- **Page Loading**: All page components are lazy-loaded via `React.lazy()` in `App.jsx` for optimal bundle splitting.
- **Route Protection**: `<ProtectedRoute requiredPermission={PERMISSIONS.*}>` gates admin-only pages with immediate redirect for unauthorized users.
- **Provider Hierarchy**: `BrowserRouter > AuthProvider > OrganizationProvider > ImportProvider > ThemeProvider > ErrorBoundary`.

## Current Routes

| Route                   | Page Component             | Description                                                     |
| ----------------------- | -------------------------- | --------------------------------------------------------------- |
| `/`                     | `DashboardPage`            | Role-scoped Home (admin KPIs/setup card; coach & parent views)  |
| `/import`               | `ImportPage`               | GotSport CSV data ingestion with validation                     |
| `/teams`                | `TeamAnalysisPage`         | Roster generation, analysis, drag-and-drop overrides            |
| `/fields`               | `FieldManagementPage`      | Venue/field/blackout date CRUD with weekly grid                 |
| `/schedule/practice`    | `PracticeSchedulingPage`   | Practice slot assignment with lock/unlock toggles               |
| `/schedule/game`        | `GameSchedulingPage`       | Interactive game schedule grid with drag-and-drop               |
| `/settings`             | `SettingsPage`             | League config, theme branding, season management                |
| `/compliance`           | `AdminComplianceDashboard` | Registration forms, waiver tracking                             |
| `/reporting`            | `AdminReportingDashboard`  | Game metrics, standings, charts                                 |
| `/standings`            | `LeagueStandings`          | Score entry, standings tables, tie-breaker logic                |
| `/registration/:formId` | `RegistrationFlow`         | Public registration form flow                                   |
| `/team/:teamId`         | `TeamRecordPage`           | Team record (tabs: schedule+RSVP+chat, roster, staff, balance)  |
| `/players`              | `PlayersPage`              | Virtualized editable players grid (audited RPC mutations)       |
| `/players/:playerId`    | `PlayerRecordPage`         | Player record with inline editing                               |
| `/teams/builder`        | `TeamBuilderPage`          | Drag-and-drop balance board (`balanceSignals`)                  |
| `/workflow`             | `WorkflowPage`             | 6-step pipeline workflow (formerly the dashboard)               |
| `/setup`                | `SeasonSetupPage`          | Resumable setup checklist (`useSetupProgress`)                  |
| `/scores`               | `ScoresPage`               | Grid score entry via `update_game_score`                        |
| `/scheduling/blackouts` | `BlackoutsPage`            | Field blackout windows review grid                              |
| `/exports`              | `ExportsPage`              | Output generation (CSVs, emails)                                |
| `/admin/members`        | `MembersPage`              | Invites & membership                                            |
| `/schedule/heat`        | `HeatForecastPage`         | Field WBGT forecast (admin, `heat_forecast` feature; NWS API)   |

## State Management

State is managed entirely through **React Context** — no external state library is used.

| Context               | File                               | Purpose                                             |
| --------------------- | ---------------------------------- | --------------------------------------------------- |
| `AuthContext`         | `contexts/AuthContext.jsx`         | Supabase auth session, user profile, login/logout   |
| `OrganizationContext` | `contexts/OrganizationContext.jsx` | Active org selection, org membership, org switching |
| `ImportContext`       | `contexts/ImportContext.jsx`       | CSV import state, parsed data, validation results   |
| `ThemeContext`        | `contexts/ThemeContext.jsx`        | Light/dark theme mode + legacy league/season state  |

## Custom Hooks (`frontend/src/hooks/`)

| Hook                     | Purpose                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `useDashboardData`       | Aggregates team, practice, game, and evaluation data             |
| `useTeamSummary`         | Team generation run data from `scheduler_runs`                   |
| `useTeamAnalysis`        | Player grouping by age/gender with season-aware age calculations |
| `useTeamPersistence`     | Snapshot packaging and Supabase persistence triggers             |
| `usePracticeSummary`     | Practice scheduling run data                                     |
| `usePracticeAssignments` | Practice slot assignment data                                    |
| `useGameSummary`         | Game scheduling run data                                         |
| `useGameAssignments`     | Game assignment data by run ID                                   |
| `useGameSlots`           | Available game time slots                                        |
| `useFields`              | Field and venue CRUD operations                                  |
| `useConflicts`           | Real-time conflict detection across scheduling data              |
| `useSchedulerRun`        | Generic scheduler run execution and status tracking              |
| `usePermission`          | RBAC permission checks against current user role                 |
| `useTeamPortal`          | Team portal data — roster, schedule, RSVP, chat                  |

## Component Organization

```text
frontend/src/components/
├── scheduling/          # Game Schedule Grid components
│   ├── GameScheduleGrid.jsx    # Interactive field × timeslot grid
│   ├── FieldColumn.jsx         # Droppable column per field
│   ├── TimeSlotDropZone.jsx    # Droppable zone per time slot
│   ├── GameCard.jsx            # Draggable game assignment card
│   └── GameConflictBanner.jsx  # Conflict summary banner
├── teaming/             # Roster management components
│   └── RosterManager.jsx       # Drag-and-drop roster with @dnd-kit
├── ui/                  # Shared UI components
├── chrome/              # TopBar, SideNav, PageHeader, Page scaffolding
├── grid/                # DataGrid (virtualized, editable) + cell/keyboard/selection
├── setup/               # SetupChecklist (resumable season setup)
├── DashboardWorkflow.jsx       # 6-step workflow orchestration (WorkflowPage)
├── ImportPanel.jsx             # CSV import with validation
├── TeamPersistencePanel.jsx    # Team save with optimistic UI
├── OutputGenerationPanel.jsx   # CSV/email export generation
├── ProtectedRoute.jsx          # RBAC route guard
├── ErrorBoundary.jsx           # Global error boundary
└── ...                         # Other panels and shared components
```

## Design System — "Lightning-class"

Defined in `frontend/src/index.css` (tokens) and `frontend/src/styles/{chrome,grid,page}.css`
(component classes). Two themes controlled via the `data-theme` attribute on `<html>`:

- **light** (default, no attribute) — Cool gray-blue backgrounds, cobalt `#2a6fdb` primary
- **`dark`** — Graphite backgrounds, lifted cobalt `#4f8ef7` primary

`ThemeContext.themeMode` drives the attribute and persists the choice to localStorage
(`sl-theme`). The typeface is self-hosted Public Sans (variable woff2; CSP forbids
remote fonts).

Key component classes: `.btn*`, `.badge`, `.card`, `.kpi`, `table.grid`, `.page-head`/`.page-tabs`,
`.modal`/`.overlay`, `.menu`, `.toast`, plus legacy `.glass-panel`/`.glass-button`/`.glass-input`
utilities retained for compatibility. Shared React primitives live in `frontend/src/components/ui/`
(`Button`, `Badge`, `Modal`, `Dropdown`, `Toggle`, `Tabs`, `Avatar`, `ToastHost`).

All colors use CSS custom properties — prototype tokens (`var(--bg-surface)`, `var(--primary)`)
with legacy aliases (`var(--color-bg-app)`, `var(--color-primary)`) — that auto-switch with theme.

## Drag-and-Drop

Two drag-and-drop surfaces use `@dnd-kit`:

1. **RosterManager** — Cross-team player swaps with `SortableContext` per team column
2. **GameScheduleGrid** — Game card moves across field × timeslot grid with `useDroppable` zones and real-time validation feedback

Both follow the same pattern: `DndContext` with `closestCorners` collision detection, `DragOverlay` for ghost cards, optimistic UI with rollback on persistence failure.

## Supabase Integration

- **Client**: `frontend/src/lib/supabaseClient.js` auto-switches between real and mock clients based on `VITE_USE_MOCK_SUPABASE` or credential availability.
- **Mock**: `frontend/src/lib/mockSupabaseClient.js` — sessionStorage-backed in-memory mock simulating `.from()`, `.select()`, `.insert()`, `.auth`, etc. Used by E2E tests.
- **Rule**: All code imports from `supabaseClient.js` — never import the mock or `@supabase/supabase-js` directly.

## Testing

- **Unit/Integration**: Vitest + `@testing-library/react` + jsdom — `npm run test`
- **E2E**: Playwright-BDD with Gherkin `.feature` files + TypeScript step definitions — `npm run test:e2e`
- **Coverage**: V8 provider with thresholds (60% statements, 50% branches, 55% functions, 60% lines) scoped to `packages/core/src/**` and `frontend/src/hooks/**`

## Accessibility (WCAG 2.2 AA)

- Keyboard-accessible interactive elements with visible focus indicators
- Semantic HTML landmarks (`<header>`, `<main>`, `<nav>`, `<section>`, `<article>`, `<footer>`)
- Non-drag alternatives for drag-and-drop interactions
- Sufficient color contrast across all themes


## Onboarding Route Flow

- Route added: `/organizations/new` (renders `frontend/src/pages/OrganizationCreation.jsx`).
- Hook added: `frontend/src/hooks/useOrganizationCreation.js` handles schema validation + `initialize_new_tenant` RPC.
- Cold-start behavior: authenticated users with zero organizations who hit `/` are redirected to `/organizations/new`; successful creation navigates back to dashboard via SPA navigation.
- Guardrails preserved: `/auth/reset-password` and `/invite/:code` remain directly reachable and are not shadowed by zero-org routing.
