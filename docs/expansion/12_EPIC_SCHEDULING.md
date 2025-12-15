# Epic: Scheduling (SCH)

**Summary**: The core value proposition. Managing Events, Resources, and Conflicts.

## 1. Requirements
*   **Events**: Games (vs Opponent, Result) vs Practices.
*   **Resources**: Venues -> Fields/Courts.
*   **Conflicts**: No overlapping events for a Team or Field.

## 2. Data Model
*   Table `venues`, `fields`.
*   Table `events`: start, end, type, field_id, home_team_id, away_team_id.

## 3. Execution Plan (PRs)

| PR # | Branch | Scope | Description | Tests |
| :--- | :--- | :--- | :--- | :--- |
| **PR-07** | `feat/sch-01-resources` | Venues | CRUD Venues/Fields. | UI CRUD tests. |
| **PR-08** | `feat/sch-02-events` | Event Model | Event Schema + Basic Scheduler UI (Calendar View). | Create Event test. |
| **PR-09** | `feat/sch-03-conflict` | Conflicts | Service logic to check overlaps on Save. | Unit tests for overlap logic (boundary cases). |
| **PR-10** | `feat/sch-04-ical` | Export | Edge Function to serve ICS content. | Fetch ICS URL -> Validate content. |
