# Development Roadmap for Youth-Sports Scheduling Program

This roadmap describes the high-level steps required to build a cost-effective youth sports scheduling application. The goal is to ingest GotSport registrations, form balanced teams with mutual buddy requests, allocate practice slots on weeknights, schedule games on Saturdays, and export per-team schedules for import into TeamSnap.

The project uses a documentation-first approach, a modern React admin shell (Vite), and Supabase for storage, RLS, and serverless functions. A recurring design pattern is:

> **Scheduler/allocator → metrics + diagnostics → persistence snapshot → admin Persistence Panel → Supabase persistence (Edge Function).**

## Progress Summary

- [x] **Requirements Analysis & Planning**  
  Requirements, constraints, and success criteria captured under `docs/requirements.md`. Intake templates and interview scripts are in place.

- [x] **Architecture & Technology Selection**  
  Target stack (Vite + React + Supabase + serverless Edge Functions) chosen and documented under `docs/architecture.md`.

- [x] **Data Modeling & Storage**  
  Relational schema, RLS strategy, and seed data are drafted in `docs/data-modeling.md`, `docs/sql/initial_schema.sql`, and `docs/sql/sample_seed_data.sql`.

- [ ] **Team Generation**
  - [x] Added server-side request processor that combines auth, validation, and transactional Supabase upserts for team snapshots.
  - [ ] Implement full Edge Function deployment and wire real scheduler runs through the new processor.

- [ ] **Practice Scheduling**  
  Allocator, metrics, and Supabase helpers are implemented. Admin UI for practice persistence and Edge Function wiring remain.

- [ ] **Game Scheduling**  
  Round-robin generator, conflict-aware allocator, metrics, and Supabase helpers are implemented. Admin UI for game persistence and Edge Function wiring remain.

- [ ] **Evaluation & Refinement**  
  Evaluation pipeline exists and ingests practice/game metrics. Wiring to scheduler runs, persistence into `evaluation_*` tables, and dashboard integration remain.

- [ ] **Output Generation & Integration**  
  CSV formatters for master/team exports are implemented. Admin export UI, Supabase Storage uploads, and email helpers remain.

- [ ] **Front-End Development**  
  Admin shell, dashboard, and Team Persistence Panel are implemented. Practice/Game Persistence Panels, ingestion flows, and Auth remain.

- [ ] **Deployment & Infrastructure**  
  Local Node/Vite scripts exist. Supabase migrations, Edge Function scaffolding, and CI/CD wiring remain.

- [ ] **Testing & Quality Assurance**  
  Node test harness covers allocators, helpers, and persistence mappers. Integration and E2E tests remain.

- [ ] **Documentation, Training, Maintenance, Future Enhancements**  
  Core system docs exist. Admin-focused training material, observability, and advanced AI features remain.

---

## 1. Requirements Analysis & Planning

**Status: Complete**

- Capture league constraints (roster sizes, buddy policy, field capacity, coach preferences, blackout dates) using the Season Intake templates.
- Maintain `docs/requirements.md` as the canonical reference for:
  - Hard constraints (e.g., mutual buddy rules, one practice/week, Saturday games).
  - Soft preferences (fairness, time-slot balance).
  - Success criteria (valid schedules, fair distributions, export formats).

No further work is required here beyond incremental updates as policies change.

---

## 2. Architecture & Technology Selection

**Status: Complete**

- Chosen stack:
  - **Front-end:** React + Vite admin shell.
  - **Backend:** Supabase (Postgres, RLS, Storage, Edge Functions).
  - **Hosting:** Vercel or Netlify for static frontend + serverless endpoints.
- Design patterns:
  - Agentic framing: separate “agents” for ingestion, team generation, practice scheduling, game scheduling, evaluation, and output.
  - Snapshot pattern: each major workflow produces a rich snapshot consumed by the admin UI.

Future changes would be refinements, not re-selection of the stack.

---

## 3. Data Modeling & Storage

**Status: Complete at the design level; migrations still pending**

- Schema:
  - Core tables: players, coaches, teams, divisions, practice_slots, game_slots, assignments, season_settings, import_jobs.
  - Run history and evaluation: `scheduler_runs`, `evaluation_runs`, `evaluation_findings`, `evaluation_metrics`, `evaluation_run_events`.
  - Exports and communication: `export_jobs`, `email_log`.
- RLS and auth:
  - Roles and policy outline under `docs/rls-policies.md`.
  - Emphasis on protecting PII while keeping admin workflows efficient.
- Seed data:
  - `docs/sql/sample_seed_data.sql` seeds a representative Fall 2024 season and linked scheduler/evaluation/export jobs.

**Next steps**

- [ ] Translate `docs/sql/initial_schema.sql` into timestamped Supabase migrations.
- [ ] Ensure `sample_seed_data.sql` runs cleanly against those migrations.
- [ ] Stand up a Supabase project and validate schema + seed scripts.

---

## 4. Team Generation

**Status: Core algorithms and client-side persistence are complete; server-side persistence remains.**

### 4.1 Completed

- **Roster sizing**
  - `src/rosterSizing.js` implements parsing of play formats (e.g. `7v7`) and computes recommended max roster sizes.

- **Allocator and diagnostics**
  - `src/teamGeneration.js`:
    - Forms balanced teams by division.
    - Tracks overflows and exposes `overflowByDivision` and `overflowSummaryByDivision`.
    - Produces buddy diagnostics so admins can see mutual vs one-sided requests.

- **Supabase mapping**
  - `src/teamSupabase.js`:
    - Maps generator teams to stable UUIDs.
    - Produces `teams` and `team_players` rows with source flags (auto/manual) aligned with Supabase expectations.

- **Manual overrides and persistence snapshot**
  - `src/teamPersistenceSnapshot.js`:
    - Normalizes and filters manual overrides.
    - Builds a single snapshot containing team rows, player rows, overrides, and run history metadata.

- **Admin UI and client**
  - `frontend/src/components/TeamPersistencePanel.jsx`:
    - Renders the team persistence snapshot, including ready-to-sync status, pending overrides, and summary counts.
  - `frontend/src/utils/teamPersistenceClient.js`:
    - Sends the snapshot to `VITE_SUPABASE_PERSISTENCE_URL` when configured, or uses a local simulator in development.
  - `frontend/src/App.jsx`:
    - Shows the team summary, readiness snapshots, and includes the Team Persistence Panel.

### 4.2 Next steps

- [ ] Implement a `team-persistence` Supabase Edge Function (or equivalent backend handler) that:
  - [x] Provide server-side validation of snapshot payloads and manual overrides.
  - [x] Validate auth/roles.
  - [x] Perform transactional upserts into `teams`, `team_players`, and `scheduler_runs`.
- [ ] Wire the Edge Function endpoint to `VITE_SUPABASE_PERSISTENCE_URL` in deployment environments.
- [ ] Integrate the real scheduler runs into the snapshot builder (replace static `teamSummarySample.js` with real data).

---

## 5. Practice Scheduling

**Status: Allocator, metrics, and Supabase mapping are implemented; UI and Edge Function persistence remain.**

### 5.1 Completed

- **Slot expansion**
  - `src/practiceSlotExpansion.js` expands season phases into concrete practice slots, handling daylight-driven duration changes.

- **Scheduler**
  - `src/practiceScheduling.js` schedules teams into available slots with:
    - Coach availability and conflicts respected.
    - Fairness scoring for distribution of late/early slots.
    - Swap-based conflict recovery.

- **Metrics and diagnostics**
  - `src/practiceMetrics.js` computes:
    - Coach conflict counts.
    - Slot utilization and concentration by day.
    - Fairness metrics per division.

- **Supabase mapping**
  - `src/practiceSupabase.js` builds `practice_assignments` rows and wraps persistence calls.

- **Readiness snapshot (sample)**
  - `frontend/src/practiceReadinessSample.js` and `App.jsx`:
    - Provide a practice readiness snapshot view in the dashboard (summary, day concentration alerts, etc).

### 5.2 Next steps

- [ ] Implement `src/practicePersistenceSnapshot.js`:
  - Aggregate scheduler outputs, metrics, overrides, and run metadata into a single snapshot.
- [ ] Build `PracticePersistencePanel.jsx`:
  - Mirror the Team Persistence Panel UX:
    - Show auto vs manual assignments.
    - Highlight conflicts and manual follow-ups.
    - Offer a “Sync to Supabase” action.
- [ ] Implement a `practice-persistence` Edge Function:
  - Accept the snapshot.
  - Validate auth and constraints.
  - Perform transactional upserts into `practice_assignments` and `scheduler_runs`.

---

## 6. Game Scheduling

**Status: Game generator, allocator, metrics, and Supabase mapping are implemented; UI and Edge Function persistence remain.**

### 6.1 Completed

- **Round-robin generation**
  - `src/gameScheduling.js`:
    - Generates round-robin weeks with byes when needed.
    - Produces deterministic matchups and bye lists.

- **Slot allocation and conflict detection**
  - `src/gameScheduling.js` and related helpers:
    - Assign matchups to game slots while respecting capacity and division constraints.
    - Detect overlapping games for teams, coaches, and fields.
    - Track unscheduled matchups and their reasons.

- **Supabase mapping**
  - `src/gameSupabase.js` builds `games` rows for persistence.

- **Readiness snapshot (sample)**
  - `frontend/src/gameReadinessSample.js` and `App.jsx`:
    - Provide a summary of scheduled games, unscheduled matchups, and warnings in the dashboard.

### 6.2 Next steps

- [ ] Implement `src/gamePersistenceSnapshot.js`:
  - Aggregate scheduled games, unscheduled matchups, and metrics into a snapshot structure.
- [ ] Build `GamePersistencePanel.jsx`:
  - Surface unscheduled games.
  - Provide tools for manual reassignment/locking before persistence.
- [ ] Implement a `game-persistence` Edge Function:
  - Validate snapshots.
  - Upsert into `games` and `scheduler_runs`.
  - Enforce division and slot integrity.

---

## 7. Evaluation & Refinement Loop

**Status: Evaluation pipeline exists; integration and persistence remain.**

- `src/evaluationPipeline.js`:
  - Aggregates practice and game metrics into readiness scores and warnings.
  - Designed to consume `scheduler_runs` outputs and produce `evaluation_runs`, `evaluation_findings`, and `evaluation_metrics` payloads.

**Next steps**

- [ ] Wire evaluation into the admin shell dashboard:
  - Replace sample metrics with live evaluation output derived from scheduler runs.
- [ ] Implement persistence into `evaluation_runs`, `evaluation_findings`, `evaluation_metrics`, and `evaluation_run_events` tables via a dedicated Edge Function or server handler.
- [ ] Add hooks so each “Sync to Supabase” action records an evaluation snapshot for audit.

---

## 8. Output Generation & Integration

**Status: Core formatters are implemented; UI and storage integration remain.**

- `src/outputGeneration.js`:
  - Produces master schedule CSVs.
  - Produces per-team CSVs suitable for TeamSnap import.

**Next steps**

- [ ] Add admin dashboard controls for:
  - Generating and downloading exports (Master + Team).
  - Selecting season/division filters.
- [ ] Integrate Supabase Storage:
  - Store generated exports with metadata.
  - Optionally link `export_jobs` table entries to stored artifacts.
- [ ] Add email drafting helpers:
  - Pre-fill coach communication templates that reference generated schedules.

---

## 9. Front-End Development

**Status: Admin shell and Team Persistence Panel are implemented; practice/game panels and Auth remain.**

- `frontend/src/App.jsx`:
  - Renders a roadmap summary (Team, Practice, Game, Evaluation, Output).
  - Shows team summary, practice readiness, game readiness, and the Team Persistence Panel.
- Layout, styling, and component structure (App.css, status pills, roadmap sections) provide a modern admin UX.

**Next steps**

- [ ] Implement `PracticePersistencePanel.jsx` and `GamePersistencePanel.jsx`.
- [ ] Replace sample snapshots with live data fetched from Supabase or Edge Functions.
- [ ] Introduce Supabase Auth to gate access:
  - Admin-only access for scheduling tools.
  - Role-based branching for future multi-user scenarios.
- [ ] Centralize state management (e.g., React context or lightweight store) as flows become more complex.

---

## 10. Deployment & Infrastructure

**Status: Local tooling is ready; cloud infrastructure is not yet wired.**

- `package.json` provides Node scripts for linting, tests, and building the frontend.

**Next steps**

- [ ] Create a Supabase project, apply migrations, and load seed data.
- [ ] Scaffold Edge Functions:
  - `process-registration-import`
  - `team-persistence`
  - `practice-persistence`
  - `game-persistence`
- [ ] Choose a hosting provider (Vercel/Netlify) and:
  - Configure build settings and env vars (Supabase URL/key, Edge Function endpoints).
  - Set up CI to run `npm test` and build on PRs.

---

## 11. Testing & Quality Assurance

**Status: Unit tests exist for core logic; integration tests remain.**

- Node’s built-in test runner is used to cover:
  - Team generation and roster sizing.
  - Practice scheduling and metrics.
  - Game scheduling and warnings.
  - Supabase mappers and snapshot helpers.

**Next steps**

- [ ] Add integration tests that:
  - Run a full “season”: team generation → practice schedule → game schedule → evaluation.
  - Assert key invariants (no conflicts, all teams scheduled, fairness thresholds).
- [ ] Add tests around Edge Functions once implemented (success paths, failure modes).

---

## 12. Documentation, Training, Maintenance & Future Enhancements

**Status: Core system docs are strong; operator docs and observability remain.**

- Documentation:
  - Requirements, architecture, data modeling, ingestion pipeline, scheduling flows, SQL drafts, and RLS policies are already well covered under `docs/`.
- Training:
  - A future “Admin Guide” should walk a league administrator through:
    - Importing registrations.
    - Generating teams.
    - Scheduling practices/games.
    - Reviewing evaluations and exporting schedules.
- Maintenance:
  - Add logging and monitoring guidance for Edge Functions.
  - Document procedures for schema changes and migrations.
- Future enhancements (long-term):
  - Advanced AI scheduling strategies beyond the current heuristic allocators.
  - Full TeamSnap API integration.
  - Multi-league, multi-tenant support.
