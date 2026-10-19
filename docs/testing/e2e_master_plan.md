[← Back to Documentation Index](docs/README.md)
---

# E2E Testing Master Plan: SquadLogic

## Philosophy: UI-Driven, Behavior-Driven Development (BDD)

SquadLogic relies on complex algorithmic engines (team generation, scheduling) and strict data governance (RBAC, multi-tenancy). To ensure the application works flawlessly for end-users, our testing strategy is **UI-Driven and Behavior-Driven**.

We use **Playwright** paired with **Cucumber/Gherkin (`.feature` files)**. This allows us to define tests in plain English domain language (e.g., "Given I am a Coach", "When I enter a game score") that map directly to automated browser interactions.

### The Antigravity IDE / Browser Sub-Agent Workflow

We leverage AI browser agents (like the Antigravity IDE `browser_subagent`) to visually inspect and interact with the application during development.

1. **Write the `.feature` file**: Define the exact behavior expected.
2. **Agent Execution**: The AI agent reads the feature file, boots the local Vite server, and uses Playwright to attempt the flow.
3. **Implementation**: The agent writes the underlying React/Supabase code until the Playwright test passes.

---

## The 4 Pillars of SquadLogic Testing

### Pillar 1: The Scheduler Test (The Engine)

**Focus**: Validating that the algorithmic outputs (Team Generation, Practice/Game Allocations) are correctly surfaced, persisted, and constrained by the UI.

- **Scenarios**:
  - Generating a round-robin schedule and verifying no team is double-booked.
  - Ensuring field capacity limits are respected in the UI grid.
  - Verifying that daylight savings time boundaries correctly split practice slots.
- **Key Assertions**: Data rendered in the `TeamScheduleView` matches the Supabase `scheduler_runs` payload.

### Pillar 2: The Coach/Admin Loop (The Daily Loop)

**Focus**: The day-to-day operational tasks performed by users once the season is active.

- **Scenarios**:
  - A Coach logging in to view their specific team's roster and upcoming practice schedule.
  - An Admin importing a new GotSport CSV and resolving validation errors.
  - A Coach inputting a game score and viewing the updated standings.

### Pillar 3: The Security & Access Test (RBAC & Multi-Tenancy)

**Focus**: Ensuring strict data isolation between Organizations and Roles.

- **Scenarios**:
  - A Coach attempting to view a team they do not manage (should be blocked by RLS and UI routing).
  - An Admin from "Organization A" attempting to access "Organization B" data.
  - A Parent viewing a public ICS feed without accessing PII (Personally Identifiable Information) of other players.
- **Key Assertions**: API calls return 403/Empty arrays; UI renders "Unauthorized" states gracefully.

### Pillar 4: The Customization Test (Edge Cases)

**Focus**: Handling the messy reality of youth sports logistics.

- **Scenarios**:
  - Mid-season late registrant additions (adding a player to a locked roster).
  - Manual overrides (Admin dragging a team from a Tuesday practice to a Thursday practice, overriding the algorithm).
  - Field closures (Admin marking a field inactive, forcing the UI to flag impacted games as "Conflicts").

---

## Sample Feature File

**File:** `tests/e2e/features/coach_daily_loop.feature`

```gherkin
Feature: Coach Daily Loop
  As a volunteer Coach
  I want to log in and view my team's schedule and roster
  So that I know where to be and who is showing up

  Background:
    Given the season "Fall 2025" is active and schedules are published
    And I am assigned as the Head Coach for the team "U10 Lightning"
    And "U10 Lightning" has a practice scheduled on "Tuesday at 5:00 PM" on "Field 1"

  Scenario: Viewing the team practice schedule
    Given I am logged into the SquadLogic dashboard as a "Coach"
    When I navigate to the "Practice Schedule" page
    Then I should see a card for "U10 Lightning"
    And the card should display "Tuesday at 5:00 PM"
    And the card should display "Field 1"
    But I should not see the practice schedule for "U10 Thunder"

  Scenario: Attempting admin actions
    Given I am logged into the SquadLogic dashboard as a "Coach"
    When I attempt to navigate to the "Data Import" page
    Then I should be redirected to the Dashboard
    And I should see an "Unauthorized access" warning
```
