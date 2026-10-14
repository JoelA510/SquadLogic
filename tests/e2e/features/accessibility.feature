@a11y
Feature: Every top-level route passes an automated accessibility scan

  axe-core (WCAG 2.0 to 2.2, levels A and AA) runs on each top-level route once it has rendered,
  in the light theme and again in the dark one, and the scenario fails on any serious or critical
  violation. A known violation that another change is fixing is listed, with its follow-up, in
  KNOWN_VIOLATIONS in tests/e2e/steps/accessibility.ts, and a listed one that no longer occurs
  fails the scan too. tests/accessibilityRoutes.test.js holds this table to App.jsx's routes.

  Green here is not WCAG 2.2 conformance: axe sees only what each route renders on the mock seed,
  and keyboard operation, focus order and dragging alternatives remain manual review.

  Scenario: The sign-in page passes axe in the light and dark themes
    Given I am signed out on the sign-in page
    Then axe finds no serious or critical violations on "/login" in the "light" theme
    When I switch the sign-in page to the dark theme
    Then axe finds no serious or critical violations on "/login" in the "dark" theme

  Scenario Outline: <route> passes axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    When I open "<route>" and see its "<heading>" heading
    Then axe finds no serious or critical violations on "<route>" in the "light" theme
    When I switch to the dark theme and reopen "<route>" with its "<heading>" heading
    Then axe finds no serious or critical violations on "<route>" in the "dark" theme

    Examples:
      | route                         | heading                |
      | /                             | Welcome back, Mock     |
      | /workflow                     | Season Setup Workflow  |
      | /import                       | Data Import            |
      | /teams                        | Teaming & Analysis     |
      | /players                      | Players                |
      | /teams/builder                | Team Builder           |
      | /scheduling/blackouts         | Blackout Dates         |
      | /scores                       | Scores & Results       |
      | /exports                      | Exports                |
      | /admin/members                | Members & Roles        |
      | /coaches                      | Coaches                |
      | /coaches/practice-preferences | Practice preferences   |
      | /schedule/practice-lighting   | Practice lighting      |
      | /schedule/heat                | Heat forecast          |
      | /fields                       | Field Management       |
      | /admin/compliance             | Compliance Dashboard   |
      | /admin/forms                  | Registration Forms     |
      | /admin/audit-logs             | Audit Explorer         |
      | /admin/analytics              | Analytical Insights    |
      | /admin/reports                | Enterprise Dashboard   |
      | /schedule/practice            | Practice Scheduling    |
      | /schedule/game                | Game Scheduling        |
      | /settings                     | Settings               |
      | /account                      | Account Settings       |
      | /standings                    | League Standings       |
      | /setup                        | Season Setup           |
      | /setup/features               | Choose your tools      |
      | /organizations/new            | Welcome to SquadLogic  |
      | /auth/reset-password          | Reset Your Password    |
