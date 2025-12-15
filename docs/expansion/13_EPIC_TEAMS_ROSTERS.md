# Epic: Teams & Rosters (TEAM)

**Summary**: Managing people and teams.

## 1. Requirements
*   **Teams**: Name, Age Group, Division.
*   **Rosters**: Players, Coaches, Jersey Numbers.
*   **Formation**: Auto-assign players from pool.

## 2. Data Model
*   Table `teams`.
*   Table `roster_entries` (link Team <-> Profile).

## 3. Execution Plan (PRs)

| PR # | Branch | Scope | Description | Tests |
| :--- | :--- | :--- | :--- | :--- |
| **PR-11** | `feat/team-01-mgmt` | CRUD | Team Management UI + RLS. | Create Team test. |
| **PR-12** | `feat/team-02-roster` | Roster | Add/Remove players, assign Jersey #. | Add Player test. |
| **PR-13** | `feat/team-03-formation`| Auto-Alloc | "Smart Roster" logic (e.g., distribute by age). | Unit test allocation algorithms. |
