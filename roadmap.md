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
  - [x] Implement full Edge Function deployment and wire real scheduler runs through the new processor.
    - [x] Derive the Supabase Edge Function base URL from `SUPABASE_URL`/`VITE_SUPABASE_URL` when no explicit persistence endpoint is configured.
    - [x] Populate `VITE_SUPABASE_PERSISTENCE_URL` from deployment Supabase URLs during frontend builds to target the live Edge Function by default.
    - [x] Wire scheduler runs from production data into the snapshot builder and persistence handler.
    - [x] Added an HTTP handler factory for the `team-persistence` endpoint to plug into Edge Functions.
    - [x] Propagate scheduler run metadata through the persistence snapshot and client requests to support Edge Function writes.
    - [x] Added a Supabase Edge Function entrypoint that wires auth role checks and service role configuration to the handler.

- [x] **Practice Scheduling**
  Allocator, metrics, Supabase helpers, persistence snapshot, admin panel, and Edge Function are all implemented.

- [x] **Game Scheduling**  
  Round-robin generator, conflict-aware allocator, metrics, Supabase helpers, persistence snapshot, admin panel, and Edge Function are all implemented.

- [x] **Evaluation & Refinement**  
  Evaluation pipeline exists and ingests practice/game metrics. Dashboard integration via `EvaluationPanel.jsx` is complete. Persistence into `evaluation_*` tables via `evaluationPersistence.js` is implemented.

- [x] **Output Generation & Integration**  
  CSV formatters for master/team exports are implemented. Admin `OutputGenerationPanel.jsx` with generate/download/upload to Supabase Storage is complete. Email helpers remain.

- [ ] **Front-End Development**  
  - [x] **UI Polish & Design System**: Implemented "Deep Space Glass" design system with dark/light/party modes, glassmorphism, and responsive layout.
  - [x] **Admin Shell**: Header, Navigation, and Layout are complete.
  - [x] **Team Persistence Panel**: Fully styled and functional (client-side).
  - [x] **Practice/Game Persistence Panels**: Implemented with Deep Space Glass styling.
  - [ ] **Auth**: Supabase Auth integration pending.

- [ ] **Deployment & Infrastructure**  
  - [x] **Security**: Resolved `esbuild` vulnerability via `npm overrides`.
  - [ ] **Cloud Wiring**: Supabase migrations, Edge Function scaffolding (beyond `team-persistence`), and CI/CD wiring remain.

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

**Status: Complete - schema and migrations applied**

- Schema:
  - Core tables: players, coaches, teams, divisions, practice_slots, game_slots, assignments, season_settings, import_jobs.
  - Run history and evaluation: `scheduler_runs`, `evaluation_runs`, `evaluation_findings`, `evaluation_metrics`, `evaluation_run_events`.
  - Exports and communication: `export_jobs`, `email_log`.
- RLS and auth:
  - Roles and policy outline under `docs/rls-policies.md`.
  - Emphasis on protecting PII while keeping admin workflows efficient.
- Seed data:
  - `docs/sql/sample_seed_data.sql` seeds a representative Fall 2024 season and linked scheduler/evaluation/export jobs.

**Completed**

- [x] Translated `docs/sql/initial_schema.sql` into timestamped Supabase migrations (`20251202000000_initial_schema.sql`).
- [x] Added `20251206000000_team_persistence_rpc.sql` for team persistence RPC.
- [ ] Ensure `sample_seed_data.sql` runs cleanly against those migrations.
- [ ] Stand up a Supabase project and validate schema + seed scripts.

---

## 4. Team Generation

**Status: Core algorithms, client-side persistence, and basic backend handler are complete.**

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
    - **Update**: Refactored to use "Deep Space Glass" design system (CSS classes, no inline styles).
  - `frontend/src/utils/teamPersistenceClient.js`:
    - Sends the snapshot to `VITE_SUPABASE_PERSISTENCE_URL` when configured, or uses a local simulator in development.
  - `frontend/src/App.jsx`:
    - Shows the team summary, readiness snapshots, and includes the Team Persistence Panel.

- **Backend**
  - `supabase/functions/team-persistence`:
    - Implemented Edge Function for transactional upserts.

### 4.2 Next steps

- [ ] Wire the Edge Function endpoint to `VITE_SUPABASE_PERSISTENCE_URL` in deployment environments.
- [x] Integrate the real scheduler runs into the snapshot builder (replace static `teamSummarySample.js` with real data).

---

## 5. Practice Scheduling

**Status: Complete - Allocator, metrics, Supabase mapping, UI, and Edge Function are all implemented.**

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

### 5.2 Completed

- [x] Implement `src/practicePersistenceSnapshot.js`:
  - Aggregates scheduler outputs, metrics, overrides, and run metadata into a single snapshot.
- [x] Build `PracticePersistencePanel.jsx`:
  - Uses Deep Space Glass style via shared `PersistencePanel` component.
  - Shows assignment counts and override status.
  - Offers "Sync to Supabase" action.
- [x] Implement a `practice-persistence` Edge Function:
  - Accepts the snapshot.
  - Validates auth and constraints.
  - Performs transactional upserts into `practice_assignments` and `scheduler_runs`.

---

## 6. Game Scheduling

**Status: Complete - Game generator, allocator, metrics, Supabase mapping, UI, and Edge Function are all implemented.**

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

### 6.2 Completed

- [x] Implement `src/gamePersistenceSnapshot.js`:
  - Aggregates scheduled games and run metadata into a snapshot structure.
- [x] Build `GamePersistencePanel.jsx`:
  - Uses Deep Space Glass style via shared `PersistencePanel` component.
  - Shows assignment counts.
  - Offers "Sync to Supabase" action.
- [x] Implement a `game-persistence` Edge Function:
  - Validates snapshots.
  - Upserts into `games` and `scheduler_runs`.
  - Enforces division and slot integrity.

---

## 7. Evaluation & Refinement Loop

**Status: Complete - Evaluation pipeline, dashboard integration, and persistence implemented.**

- `src/evaluationPipeline.js`:
  - Aggregates practice and game metrics into readiness scores and warnings.
  - Designed to consume `scheduler_runs` outputs and produce evaluation payloads.

**Completed**

- [x] Wire evaluation into the admin shell dashboard:
  - `EvaluationPanel.jsx` runs live evaluations from schedule data and displays status/issues.
- [x] Implement persistence into `evaluation_runs` and `evaluation_findings` tables via `src/evaluationPersistence.js`.

**Next steps**

- [ ] Add hooks so each "Sync to Supabase" action records an evaluation snapshot for audit.

---

## 8. Output Generation & Integration

**Status: Core formatters, admin UI, and storage integration are implemented.**

- `src/outputGeneration.js`:
  - Produces master schedule CSVs.
  - Produces per-team CSVs suitable for TeamSnap import.

**Completed**

- [x] Add admin dashboard controls for:
  - `OutputGenerationPanel.jsx` generates and downloads exports (Master + Team CSVs).
- [x] Integrate Supabase Storage:
  - `storageSupabase.js` and panel upload functionality implemented.

**Next steps**

- [ ] Add season/division filter controls to output panel.
- [ ] Link `export_jobs` table entries to stored artifacts.
- [ ] Add email drafting helpers:
  - Pre-fill coach communication templates that reference generated schedules.

---

## 9. Front-End Development

**Status: Admin shell and Team Persistence Panel are implemented and polished; practice/game panels and Auth remain.**

- `frontend/src/App.jsx`:
  - Renders a roadmap summary (Team, Practice, Game, Evaluation, Output).
  - Shows team summary, practice readiness, game readiness, and the Team Persistence Panel.
- **UI Polish**:
  - Implemented "Deep Space Glass" design system.
  - Refactored `App.css` and `index.css` for consistent theming (Dark/Light/Party).
  - Removed inline styles from `TeamPersistencePanel`.
  - Added dynamic glow effects for status indicators.

**Completed**

- [x] Implement `PracticePersistencePanel.jsx` and `GamePersistencePanel.jsx` using the shared `PersistencePanel` component.
- [x] Implement `EvaluationPanel.jsx` for live schedule evaluation display.
- [x] Implement `OutputGenerationPanel.jsx` for CSV generation and upload.

**Next steps**

- [ ] Replace sample snapshots with live data fetched from Supabase or Edge Functions.
- [ ] Introduce Supabase Auth to gate access:
  - Admin-only access for scheduling tools.
  - Role-based branching for future multi-user scenarios.
- [ ] Centralize state management (e.g., React context or lightweight store) as flows become more complex.

---

## 10. Deployment & Infrastructure

**Status: Local tooling is ready; cloud infrastructure is partially wired.**

- `package.json` provides Node scripts for linting, tests, and building the frontend.
- **Security**: `esbuild` vulnerability resolved via `npm overrides`.

**Next steps**

- [ ] Create a Supabase project, apply migrations, and load seed data.
- [x] Scaffold Edge Functions:
  - [ ] `process-registration-import` (not yet implemented)
  - [x] `practice-persistence`
  - [x] `game-persistence`
  - [x] `team-persistence`
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
  - `README.md` updated to include design system details.
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
