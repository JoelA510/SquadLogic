[← Back to Documentation Index](../README.md)
---

# Production Roadmap: SquadLogic Expansion

**Strategy**: "Full Suite Realization". The v1.0 roadmap transformed SquadLogic from a core scheduling engine into a deployed club management platform. Release-readiness hardening for the next cut remains active, with durable import promotion, roster constraints, coach/admin workflows, performance tightening, and final validation tracked as v1.1 work.

_Note on Epics: Epics 10 through 17 established the v1.0 baseline. Current documentation should distinguish shipped validation/import-job flows from the still-pending durable apply path into player, coach, and team records._

---

## Phase 1: Implemented Baseline (Completed)

**Goal**: Establish the bedrock, data models, and feature-complete platform.

- **Foundations**: Vitest, ESLint, Prettier, Monorepo structure (`@squadlogic/core`).
- **Core Data Model**: Supabase Organizations, Users, Profiles, RLS Policies, Context Providers.
- **Scheduling Engine**: Round-robin generation, conflict-aware slot allocation, daylight savings expansion.
- **Team Formation**: Auto-drafting honoring mutual buddy requests, coach assignments, and roster caps.
- **Evaluation Pipeline**: Automated readiness scoring, fairness metrics, and conflict detection.
- **Frontend Shell**: React Router, the "Lightning-class" design system (cobalt light/dark themes), Theme Context, Dashboard Aggregation Hooks.
- **Facility Management**: Full CRUD UI for Venues, Fields, and Blackout Dates.
- **Communication (M3.2)**: RSVP tracking, trigger-based notifications (Rainouts, Schedule Changes), and Team Chat.
- **Calendar Sync (M3.3)**: Public ICS feeds for parents and coaches.
- **Registration & Compliance (M3.4)**: Custom form builder, waiver tracking, and boolean compliance dashboards.
- **Reporting (M3.5)**: Game score entry, standings calculations, and tie-breaker logic.

## Phase 2: Refinement & Security (Completed)

**Goal**: Polish the admin experience, enforce security, and ensure type safety.

- **Milestone 2.1: RBAC & Multi-Tenancy**: Broadened `usePermission` enforcement across all routes. Tightened RLS to strictly require `organization_id` checks.
- **Milestone 2.2: Ingestion Hardening**: Shipped CSV validation, import-job tracking, and error recovery. Durable staged promotion into `players`, `coaches`, and field-slot records (with apply/rollback) has since shipped.
- **Milestone 2.3: Admin Overrides**: Completed UI for drag-and-drop roster adjustments and manual practice slot overrides.
- **Milestone 2.4: Output Operationalization**: Connected CSV formatters to Supabase Storage and finalized coach email generation.
- **Milestone 2.5: Type Safety & UX Polish**: Resolved >80 TypeScript errors and standardized the then-current "Deep Space Glass" design system across all components (since replaced by Lightning-class — see Phase 11).

---

## Post-v1.0 Work

Following v1.0 completion, additional work was executed under **Epic 19: Launch & Beyond**:

- **Phase 1 (Completed with operator follow-up):** GitHub Actions CI/CD pipeline and Vercel production deployment. Branch protection remains an operator-owned setting to validate before release sign-off.
- **Phase 2 (Completed):** Interactive Game Schedule Grid with drag-and-drop (`@dnd-kit`), real-time validation, and the final E2E test scenario
- **Phase 3 (Completed):** Live Supabase backend transition, Edge Function deployment, production cutover (see [`production-cutover.md`](../operations/production-cutover.md))

Additionally, a comprehensive **4-phase security audit** was completed in March 2026; its remediations shipped in the v1.0.1 hardening PRs and migrations.

---

## Phase 7: Audit & Analytics Persistence (Completed)

**Goal**: Establish immutable audit trails and structured analytics for all admin actions.

- **Audit Pipeline**: `record_audit_event` RPC with telemetry and compliance metadata.
- **Analytics Persistence**: `persist_evaluation_run` overloaded RPC with findings/metrics sub-tables.
- **Observability Layer**: Phase 4 telemetry RPCs, efficiency metrics views, import job progress tracking.

## Phase 8: Intelligent Auto-Scheduler (Completed)

**Goal**: Server-side Hill Climbing optimizer for practice schedule generation.

- **Edge Function**: `auto-scheduler` with seeded PRNG, greedy seed, swap/relocate/chain-swap mutations.
- **Scoring Engine**: `evaluatePracticeSchedule` exists **twice** — `packages/core/src/practiceMetrics.js` for the client and `supabase/functions/_shared/engines/scoring-engine.ts` for the Edge Function, because an Edge Function cannot import `packages/core`. This line used to call them "isomorphic" and "shared"; they are neither, and the two drifted on `assignedTeams` while the claim stood. The Edge arm is a narrower evaluator for hill-climbing fitness. The fields the two must agree on are enforced by `tests/scoringEngineDrift.test.js`.
- **Realtime Progress**: Live iteration/score tracking via `audit_log` Realtime subscription.
- **Governance**: Full evaluation_run persistence with findings and metrics.
- **Retention**: Reduced default retention from 365 → 180 days for free-tier storage protection.

## Phase 9: Production Hardening & Global Deployment (Certified — Prime)

**Goal**: Transition Phase 8 into a production-ready, globally resilient system optimized for Supabase Free Account.

- **Edge Optimization**: CPU yield every 100 iterations + 140s wall-clock safety cutoff for free-tier compliance.
- **Enterprise Observability**: Sentry React SDK with `ErrorBoundary` integration and `withProfiler`. BetterStack/Logtail structured JSON logger for Edge Functions with buffered flush.
- **Resilience & Failover**: `OfflineGuard` glassmorphic overlay with adaptive connectivity monitoring (30s/10s polling). `useMaintenanceMode` hook with Supabase Realtime subscription to `organizations.settings.maintenance_mode` flag.
- **Performance**: In-memory TTL cache with stale-while-revalidate for 200ms dashboard interaction ceiling.
- **Data Governance**: `audit_log` 180-day retention pruning function + composite index. `maintenance_mode` flag backfilled to all organizations.

## Phase 10: Pre-Flight Certification (Completed)

**Goal**: Final lockdown, operational documentation, and production seal for v1.0 GA.

- **Production Gating**: `config.js` safety guard prevents mock mode from running on production domains — throws a user-friendly Configuration Error screen with remediation steps.
- **Dev Mode Indicator**: Glassmorphic "Mock Mode Active" badge in the sidebar, only visible when `IS_MOCK_MODE` is true. Links to `ENVIRONMENT.md` for setup context.
- **Operational Documentation**: Comprehensive [`ENVIRONMENT.md`](../operations/ENVIRONMENT.md) cataloging every environment variable for Vercel, Supabase Edge Functions, and GitHub Actions CI/CD.
- **Code Cleanup**: Codebase scanned for hardcoded credentials, debug endpoints, and leftover `console.*` noise. All sensitive values abstracted to `.env`.
- **Quality Seal**: CI/E2E and pgTAP were restored on `main` during the 2026-05-02 release-readiness pass. Final release sign-off still depends on the remaining v1.1 backlog and review sweeps.

## Phase 11: Lightning-class Enterprise Redesign (Completed — June 2026)

**Goal**: Full UI/UX overhaul on top of the existing backend infrastructure (PR #322).

- **Design system**: Cobalt light + dark token system (`data-theme`), self-hosted Public Sans, shared UI primitives.
- **Chrome & IA**: TopBar (org/season switchers, global search, role preview) + nested collapsible SideNav with role-scoped views; new routes with legacy redirects.
- **Players workspace**: Virtualized editable DataGrid with audited admin mutation RPCs; player & team record pages absorbing the team portal.
- **Team Builder**: Drag-and-drop balancing (serpentine signal, buddies, coach-parent spreading).
- **Feature config**: Org-level toggles + division `gender_model` with co-ed merge / gender split transitions.
- **Season Setup**: Resumable checklist replacing the progress-wiping wizard; role-scoped Home dashboards.
- **Schema**: Migrations `20260611000000`–`20260611000400` (roster fields, admin RPCs, expanded GotSport mapping, audit-action whitelist, `team_players` sync trigger).

---

## Open Items (current backlog)

Operator-owned (pre-release verification):

- [ ] Set `VITE_SENTRY_DSN` in Vercel production and run the [Sentry smoke test](../operations/sentry-smoke.md).
- [ ] Enable Supabase leaked-password protection ([runbook](../operations/leaked-password-protection.md)).
- [ ] Verify branch protection on `main` and re-run production Supabase advisors after applying the `20260611*` migration batch.

Engineering backlog:

- [ ] Automated accessibility checks in E2E (`@axe-core/playwright`) and a post-redesign WCAG 2.2 AA re-certification pass (the pre-redesign certification was retired with the redesign).
- [ ] Lighthouse CI performance budget for the production bundle.
- [ ] One-click snapshot-aware teaming re-run from the co-ed merge/split modal (currently players move and rosters are rebuilt in the Team Builder).
- [ ] v1.1 feature areas — import write-through completion (team promotion), division team-size configuration, placeholder coaches/admin swap — see [`v1.1-planning.md`](v1.1-planning.md).
- [ ] Org-scoped coach email uniqueness (currently globally `UNIQUE`; a multi-org constraint change is needed before scaling beyond one org per deployment).
