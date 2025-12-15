# Production Roadmap: SquadLogic Expansion

**Strategy**: "Core First, Then Features". Build the robust data model and scheduling engine before adding notifications and reporting.

## Phase 1: Foundations & Core Domain
**Goal**: Establish a stable, multi-tenant repository with enforced quality standards and secure data access.
*   **Milestone 1.1: Foundations**: Types, Testing Harness (Vitest), Linting, CI Checks.
*   **Milestone 1.2: Core Data Model**: Supabase Organizations, Users, RLS Policies, Context Providers.

## Phase 2: The Scheduling Engine (Killer Feature)
**Goal**: Deliver a conflict-aware scheduling system (the primary value prop).
*   **Milestone 2.1: Events & Facilities**: Schema for Games, Practices, Venues, Fields.
*   **Milestone 2.2: Scheduler UI**: Drag-and-drop or Grid view for event management.
*   **Milestone 2.3: Logic Layer**: Conflict detection service (double-booking protection).

## Phase 3: Team Operations & Rostering
**Goal**: Enable coaches/admins to manage their people effectively.
*   **Milestone 3.1: Roster Management**: Player/Staff assignment, Roles.
*   **Milestone 3.2: Registration Data**: Custom forms and data ingestion (CSV).
*   **Milestone 3.3: Team Formation**: "Smart Roster" tools (Auto-draft).

## Phase 4: Communication & Engagement
**Goal**: Keep users informed and engaged.
*   **Milestone 4.1: Availability**: RSVP tracking (Yes/No/Maybe).
*   **Milestone 4.2: Notifications**: Email/SMS triggers (via Supabase Edge Functions + Provider).
*   **Milestone 4.3: Calendar Sync**: Public ICS feeds.

## Phase 5: Reporting & Polish
**Goal**: Visual value and analytics.
*   **Milestone 5.1: Standings**: Auto-calculation of league tables.
*   **Milestone 5.2: Compliance Dashboard**: Tracking toggle/boolean status.

---

## Execution Sequence (Epics)

| Sequence | Epic ID | File | Description |
| :--- | :--- | :--- | :--- |
| 1 | **FND** | `10_EPIC_FOUNDATIONS.md` | Repo Setup, Tests, Base Types. |
| 2 | **CORE** | `11_EPIC_CORE_DOMAIN.md` | Org/User Schema, RLS, Auth. |
| 3 | **SCH** | `12_EPIC_SCHEDULING.md` | Events, Venues, Scheduler UI, Conflicts. |
| 4 | **TEAM** | `13_EPIC_TEAMS_ROSTERS.md` | Rosters, Team Formation. |
| 5 | **COMMS** | `14_EPIC_COMMS.md` | Notifications, RSVP, Chat. |
| 6 | **DATA** | `15_EPIC_REGISTRATION_DATA.md` | Forms, Ingestion. |
| 7 | **RPT** | `16_EPIC_REPORTING.md` | Standings, Stats, Dashboards. |
