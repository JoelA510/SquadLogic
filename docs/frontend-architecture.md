# Front-End Architecture Plan

This document breaks down the roadmap's front-end milestones into an actionable Create React App (CRA) implementation strategy. It establishes the page layout, state management approach, data-fetching patterns, and testing expectations so subsequent engineering tasks have clear guardrails.

## UI Shell & Navigation
- **Routing**: Use `react-router-dom` v6 with a top-level `AppShell` that renders persistent navigation (sidebar on desktop, collapsible drawer on mobile).
- **Layout primitives**: Implement a shared `PageHeader`, `Toolbar`, and `Card` component library leveraging CSS Modules or Tailwind (decision pending design assets). Prioritize responsive breakpoints (≥320px mobile, ≥768px tablet, ≥1024px desktop).
- **Global status surfaces**: Reserve a notification/toast area tied to Supabase events (ingestion progress, evaluation results) and a global loading indicator for long-running jobs.

## Core Screens & Component Slices
1. **Dashboard**
   - KPIs: total players imported, teams generated, practices scheduled, evaluation status.
   - Components: `SummaryStat`, `ProgressTimeline`, `RecentActivity` (backed by Supabase `import_jobs` and scheduler run logs).
2. **Data Import**
   - Tabs for registrations vs. field slots.
   - Components: `CsvUploadDropzone`, `ImportHistoryTable`, `ValidationResultDrawer`.
   - Hooks trigger Supabase Storage uploads, poll Edge Function status, and stream job metrics via Realtime.
3. **Configuration**
   - Form sections for roster rules, buddy policy toggles, season dates.
   - Components: `SeasonSettingsForm`, `RosterFormulaTable`, `DateRangePicker` (wraps `react-day-picker`).
   - Use Zod schemas for validation and integrate with `react-hook-form`.
4. **Team Review**
   - Table with expandable rows showing roster details.
   - Components: `TeamRosterTable`, `RosterSwapModal`, `BuddyTag`.
   - Drag-and-drop via `@dnd-kit/core`; persist manual swaps with Supabase RPC calls.
5. **Practice Scheduler**
   - Calendar-style grid grouped by weekday/field.
   - Components: `PracticeScheduleGrid`, `ConflictBadge`, `SlotDetailDrawer`.
   - Provide run controls ("Generate", "Resolve Conflicts") with progress modals.
6. **Game Scheduler**
   - Similar grid but grouped by Saturday dates.
   - Components: `GameScheduleGrid`, `MatchupCard`, `ByeIndicator`.
7. **Evaluation**
   - Findings list, charts for fairness metrics, audit history timeline.
   - Components: `FindingsTable`, `FairnessChart` (wrapping Recharts or Chart.js), `EvaluationRunHistory`.
8. **Exports & Communications**
   - Download cards for master/team files, email template previewer.
   - Components: `ExportCard`, `EmailPreviewPane`, `SendChecklist`.

## State Management & Data Access
- Adopt **React Query** for server-state caching with query keys per resource (`['players', seasonId]`, `['practiceAssignments', runId]`).
- Store local UI state (filters, modal visibility) in `zustand` slices to avoid prop drilling.
- Centralize Supabase client initialization in `supabaseClient.ts` and wrap the app in a context providing authenticated session info.
- Implement optimistic updates for manual roster and schedule adjustments while verifying outcomes via evaluation reruns.

## Supabase Integration Strategy
- **Authentication**: Start with service-role key in serverless context; front end gated behind a shared admin passcode stored in environment config until Supabase Auth is enabled.
- **Edge Functions**: Define typed client wrappers (e.g., `importRegistrations`, `runPracticeScheduler`) returning discriminated unions `{ status: 'queued' | 'running' | 'error', data?: ... }`.
- **Realtime channels**: Subscribe to `import_jobs` and scheduler run tables to push live status updates into React Query caches.

## Styling & Accessibility
- Establish a theming system using CSS custom properties for colors/spacing to support dark mode later.
- Follow WCAG 2.1 AA: ensure component library ships with keyboard focus states, ARIA labels on drag handles, and semantic heading structure per page.
- Integrate Axe accessibility checks in Storybook (future) or via Jest + `@testing-library/jest-dom` to catch regressions.

## Testing & Tooling
- **Unit tests**: `@testing-library/react` for components, `jest` snapshots for layouts, Zod schema tests.
- **Integration tests**: Cypress component tests for drag-and-drop workflows and scheduler run flows (stub Supabase API).
- **Performance budget**: Track bundle size with `source-map-explorer`; enforce <200KB initial JS after gzip.
- **CI hooks**: Lint (`npm run lint`), type-check (`tsc --noEmit`), and run targeted Jest suites on pull requests touching `src/`.

## Incremental Delivery Milestones
1. Scaffold CRA project with routing, Supabase client bootstrap, and placeholder navigation.
2. Implement Data Import screen with live import history reading from stubbed data.
3. Build Team Review workflow, then expand into practice/game schedulers.
4. Layer in Evaluation dashboards and export utilities.
5. Polish accessibility, performance, and offline error handling before production hardening.

## Open Questions
- Finalize UI component library choice (headless vs. prebuilt design system like Chakra UI).
- Confirm whether admin authentication should launch with Supabase email magic links or remain passcode-protected MVP.
- Determine if scheduling agents run via Netlify Scheduled Functions or Supabase Edge Function cron, as this affects UI polling patterns.
