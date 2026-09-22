# SquadLogic

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="frontend/public/SL-Logo-dark.png" />
  <img src="frontend/public/SL-Logo.png" alt="SquadLogic Logo" width="180" height="180" />
</picture>

> **Focus on the Field.**
>
> SquadLogic converts raw GotSport registration data into actionable teaming and scheduling frameworks, designed specifically to support youth sports organizations.

> **Release status**: v1.0.1 (2026-04-23) shipped; the "Lightning-class" enterprise redesign has since merged to `main` (unreleased). See [`CHANGELOG.md`](CHANGELOG.md) and [`docs/operations/ci-cd.md`](docs/operations/ci-cd.md).
> **CI**: [![CI](https://github.com/JoelA510/SquadLogic/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JoelA510/SquadLogic/actions/workflows/ci.yml)
> **Deployment**: https://squadlogic.vercel.app/

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)
[![Vite](https://img.shields.io/badge/Vite-7.x-646cff)](https://vitejs.dev/)

---

## 🚀 Overview

SquadLogic is a comprehensive tool for youth sports administrators. It simplifies the complex logistics of organizing leagues by automating team generation, practice scheduling, and game scheduling. Built with a modern tech stack and the cobalt **"Lightning-class" design system** (light & dark themes), it offers a premium, intuitive user experience.

## ✨ Features

### Core platform (v1.0)

- **Core Domain & Utilities**: Shared `@squadlogic/core` package for metrics, evaluation, normalization, and error handling (pure JS, framework-agnostic).
- **Automated Team Generation**: Snapshot-aware, incremental allocation of players to teams honoring mutual buddy requests, coach assignments, and manual locks across re-runs.
- **Practice & Game Scheduling Engines**: Conflict-aware round-robin generation and field/time slot allocation.
- **Evaluation Pipeline**: Automated readiness scoring, fairness metrics, and conflict detection.
- **Supabase Persistence**: Edge Functions and audited SECURITY DEFINER RPCs for all state changes — no direct table writes.
- **Durable CSV Import**: Staged GotSport ingestion (players, coaches, field slots) with validation, idempotent re-import, apply/rollback, and expanded field mapping (years played, payment status, waitlist, guardians, gendered divisions).
- **Role-Based Access Control (RBAC)**: Comprehensive permission enforcement across all UI flows and RLS policies.
- **Multi-Tenant Enforcement**: Strict organization partitioning ensuring data isolation.
- **Facility Management**: Full CRUD UI for venues, fields, blackout dates, and availability profiles.
- **Communication**: RSVP tracking, trigger-based notifications (rainouts, schedule changes), and team messages.
- **Calendar Sync**: Public ICS feeds for parents and coaches.
- **Registration & Compliance**: Custom form builder, waiver/payment/medical tracking (boolean toggles — no document storage), and a compliance dashboard.
- **Reporting**: Game score entry, standings calculations, and tie-breaker logic.

### Lightning-class redesign

- **Design system**: Cobalt light + dark themes driven by CSS tokens (`data-theme` on `<html>`, persisted preference), self-hosted Public Sans, and a shared UI primitive library.
- **App chrome**: Top bar with org/season switchers, global search (`/` shortcut), and role preview; nested collapsible navigation with role-scoped views for coaches and parents.
- **Players workspace**: Excel-grade editable, virtualized data grid (click-to-edit, keyboard navigation, multi-select bulk actions, instant search) smooth at 1,400+ rows.
- **Record pages**: Tabbed player records (overview, guardians, schedule, compliance) and team records absorbing the team portal (roster, schedule, staff, messages, RSVP).
- **Team Builder**: Drag-and-drop roster balancing with a serpentine signal balancer (rating or years-played), buddy links, and coach-parent spreading — every move audited.
- **Org feature configuration**: Per-organization toggles (player rating, years played, buddy requests, coaching interest, medical forms, waitlist) and a division **gender model** — gendered (U8B/U8G) or co-ed display with real merge/split transitions.
- **Season Setup**: Resumable checklist that derives progress from live data — leave and return without losing your place.
- **Role dashboards**: Admin KPI home, coach dashboard, and parent dashboard, each scoped to what that role needs.

## 🛠️ Tech Stack

- **Frontend**: React 19, Vite 7, react-router-dom v7
- **Styling**: Vanilla CSS design tokens ("Lightning-class" design system, light & dark) + Tailwind CSS 4
- **Backend**: Node.js, Supabase (PostgreSQL, Edge Functions, Storage, Auth)
- **Testing**: Vitest (unit/integration), Playwright-BDD (E2E)
- **Analysis**: TypeScript (`checkJs` + `allowJs`), ESLint (flat config), Prettier

## 🗺️ Current Routes

The application is structured around the following workflows (see `frontend/src/App.jsx`; legacy paths redirect):

- `/` — **Home**: Role-scoped dashboard (admin KPIs, coach view, parent view).
- `/setup` — **Season Setup**: Resumable onboarding/season checklist (`/setup/features` for feature selection).
- `/import` — **Data Import**: Staged GotSport CSV ingestion (players, coaches, field slots) with rollback.
- `/players` — **Players**: Editable roster grid; `/players/:playerId` for individual records.
- `/teams` — **Teams**: Generation, analysis, and re-runs; `/teams/builder` for drag-and-drop balancing; `/team/:teamId` for team records.
- `/coaches` — **Coaches**: Volunteer review, promotion, and team assignment.
- `/fields` — **Field Management**: Venues, sub-units, and priorities; `/scheduling/blackouts` for blackout dates.
- `/schedule/practice` & `/schedule/game` — **Scheduling**: Practice slot assignment and round-robin game generation.
- `/scores` & `/standings` — **Results**: Score entry and standings.
- `/exports` — **Exports**: Output generation (rosters, schedules).
- `/admin/*` — **Administration**: Members, compliance, forms, reports, analytics, audit logs.
- `/settings` — **Settings**: Organization configuration, feature toggles, invites, and audit log.

## 🏁 Getting Started

### Prerequisites

- Node.js (v20 or higher; CI and the Vercel production build run on Node 24)
- npm (v10 or higher)
- A Supabase Project (for database and auth) — or run in mock mode (below) with no backend at all

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/JoelA510/SquadLogic.git
   cd SquadLogic
   ```

2. **Install dependencies:**

   ```bash
   npm ci
   ```

3. **Environment Setup:**
   Copy `.env.example` to `.env.local` and populate your Supabase credentials.
   For a full list of all environment variables (frontend, Edge Functions, CI/CD), see [**Environment Variables Reference**](docs/operations/ENVIRONMENT.md).

4. **Start the development server:**
   ```bash
   npm run frontend:dev
   ```
   The application will be available at `http://localhost:5173`.

> **Mock mode**: set `VITE_USE_MOCK_SUPABASE=true` (or omit Supabase credentials) to run against a fully seeded in-browser mock — no database required. This is how the E2E suite runs.

### Building for Production

To create a production build:

```bash
npm run frontend:build
```

## 📄 Documentation

The SquadLogic knowledge base is organized into a categorized hierarchy for high discoverability and audit traceability. For the full index, see [**`docs/README.md`**](docs/README.md).

### 🏛️ Architecture & Core
- [**System Overview**](docs/architecture/system-overview.md): Full tech stack and system diagram.
- [**Frontend Architecture**](docs/architecture/frontend-architecture.md): Routing, hooks, and component patterns.
- [**Data Modeling**](docs/architecture/data-modeling.md): Database schema and multi-tenant isolation.
- [**Scheduling Algorithms**](docs/architecture/game-scheduling.md): Team generation and field allocation logic.

### 🛡️ Security & Governance
- [**CSP Policy**](docs/security/csp.md): Enforced Content-Security-Policy and waiver rationale.
- [**RLS Policies**](docs/security/rls-policies.md): Strict multi-tenant data access rules.
- [**Lessons Learned**](docs/LESSONS_LEARNED.md): Durable engineering knowledge from the build-out.
- [**Governance Framework**](docs/governance/governance-framework.md): RPC enforcement and Zod validation mandates.

### 🚀 Roadmap & Operations
- [**Expansion Roadmap**](docs/expansion/03_ROADMAP.md): Current sprint and milestone tracking.
- [**E2E Testing Master Plan**](docs/testing/e2e_master_plan.md): Playwright-BDD coverage and quality gates.
- [**Production Cutover**](docs/operations/production-cutover.md): Deployment runbook and environment setup.
- [**UI/UX Guidelines**](docs/ui/agent-ui-ux-guidelines.md): "Lightning-class" design standards and accessibility requirements.

## 📄 License

This project is licensed under the [ISC License](https://opensource.org/licenses/ISC).
