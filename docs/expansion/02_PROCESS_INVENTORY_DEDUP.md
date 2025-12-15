# Process Inventory & Deduplication

**Legend:**
-   **[NEW]**: New feature to implement.
-   **[EXISTING]**: Feature exists in codebase (needs verification/refactor).
-   **[UPDATE]**: Feature exists but needs expansion.

## 1. Core Domain & Administration

| ID | Feature Name | Description | Acceptance Criteria | Existing? |
| :--- | :--- | :--- | :--- | :--- |
| **ADM-01** | **Multi-Tenant Org Structure** | Support for separate Organizations (leagues/clubs) with distinct data isolation. | - RLS policies ensure User A cannot see Org B's data.<br>- Org settings page. | [EXISTING] (Supabase schema exists) |
| **ADM-02** | **Role-Based Access Control** | Granular permissions for Admin, Coach, Player, Parent. | - Admins: Full access.<br>- Coaches: R/W own team.<br>- Players/Parents: Read-only own team + RSVP. | [EXISTING] (Basic roles exist, need refinement) |
| **ADM-03** | **User Profiles** | Unified profile for a user across multiple orgs/teams (if applicable). | - Edit profile (Name, Contact).<br>- Link Parent to Child accounts. | [UPDATE] (Needs Parent-Child linking) |

## 2. Scheduling Engine

| ID | Feature Name | Description | Acceptance Criteria | Existing? |
| :--- | :--- | :--- | :--- | :--- |
| **SCH-01** | **Game/Practice Scheduler** | Create, edit, delete events. Assign teams, locations, times. | - Drag-and-drop or form-based creation.<br>- Distinguish Game vs Practice. | [EXISTING] (Basic scheduler exists) |
| **SCH-02** | **Conflict Detection** | Prevent double-booking of teams or fields. | - Warning/Error if Team A has 2 games at same time.<br>- Warning if Field 1 is double-booked. | [NEW] |
| **SCH-03** | **Automated Schedule Builder** | Generate a season schedule based on parameters (Round Robin). | - Input: Teams, Dates, Field slots.<br>- Output: Conflict-free schedule. | [NEW] (See TeamLinkt/JerseyWatch reqs) |
| **SCH-04** | **Facility Management** | Manage Venues, Fields/Courts, and Availability/Blackouts. | - CRUD Venues/Fields.<br>- Define blackout dates (maintenance). | [NEW] |
| **SCH-05** | **Calendar Sync** | Export schedule to iCal/Google Calendar. | - Public ICS feed URL per team/user. | [NEW] |

## 3. Team Management & Rostering

| ID | Feature Name | Description | Acceptance Criteria | Existing? |
| :--- | :--- | :--- | :--- | :--- |
| **TM-01** | **Roster Management** | Assign players/staff to teams. | - Add/Remove members.<br>- Jersey number assignment. | [EXISTING] (Basic rosters exist) |
| **TM-02** | **Smart Team Formation** | Auto-distribute pool of registered players into teams. | - Rules: Balance by age, skill, or "draft" mode.<br>- Drag-and-drop adjustments. | [NEW] (SquadFusion "Smart Rosters") |
| **TM-03** | **Availability/RSVP** | Track who can attend events. | - User marks Yes/No/Maybe.<br>- Coach sees summary list. | [NEW] (TeamSnap/Spond style) |

## 4. Communication

| ID | Feature Name | Description | Acceptance Criteria | Existing? |
| :--- | :--- | :--- | :--- | :--- |
| **COM-01** | **Notifications System** | Trigger-based alerts (email/push). | - Triggers: Schedule change, New Event, Announcement.<br>- User prefs (email vs silent). | [NEW] |
| **COM-02** | **Team Chat/Feed** | Contextual discussion per team or event. | - Simple threaded message board per team.<br>- Admin broadcast to all teams. | [NEW] |
| **COM-03** | **Smart Alerts** | "Game Changed" or "Rainout" urgent alerts. | - Distinct UI style for urgent alerts.<br>- Immediate dispatch. | [NEW] |

## 5. Registration (Data Only)

| ID | Feature Name | Description | Acceptance Criteria | Existing? |
| :--- | :--- | :--- | :--- | :--- |
| **REG-01** | **Form Builder** | Create custom data collection forms for seasonal intake. | - Custom fields (Text, Select, Date).<br>- Published public link. | [NEW] |
| **REG-02** | **Data Ingestion** | Import players from CSV/External source. | - Map CSV columns to profile fields.<br>- Bulk create user records. | [NEW] |

## 6. Reporting & Analytics

| ID | Feature Name | Description | Acceptance Criteria | Existing? |
| :--- | :--- | :--- | :--- | :--- |
| **REP-01** | **Standings & Results** | Auto-calculate league standings from game scores. | - Input score -> Update W/L/D/Pts table.<br>- Tie-breaker logic (simple). | [NEW] |
| **REP-02** | **Process Compliance** | Track toggle status (e.g. "Waiver Signed"). | - Boolean field on roster.<br>- Dashboard count (e.g. "80% complete"). | [NEW] |
