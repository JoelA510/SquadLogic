@a11y
Feature: Every top-level route passes an automated accessibility scan

  axe-core (WCAG 2.0 to 2.2, levels A and AA) runs on each top-level route once it has rendered,
  in the light theme and again in the dark one, and the scenario fails on any serious or critical
  violation. A known violation that another change is fixing is listed, with its follow-up, in
  KNOWN_VIOLATIONS in tests/e2e/steps/accessibility.ts, and a listed one that no longer occurs
  fails the scan too. tests/accessibilityRoutes.test.js holds this table to App.jsx's routes.

  Each route is scanned with content on it: the table's third column is text the scan must see
  rendered, and a route the mock seed leaves empty has its own scenario below that gives it
  content first (a blackout, a forecast, lighting requests, evaluation runs, an invite, a staged
  game schedule). Record pages are scanned on seeded records.

  Green here is not WCAG 2.2 conformance: axe sees only what each route renders, closed overlays
  are not scanned, and keyboard operation beyond the grid scenario, focus order and dragging
  alternatives remain manual review.

  Scenario: The sign-in page passes axe in the light and dark themes
    Given I am signed out on the sign-in page
    Then axe finds no serious or critical violations on "/login" in the "light" theme
    When I switch the sign-in page to the dark theme
    Then axe finds no serious or critical violations on "/login" in the "dark" theme

  Scenario: Arrow keys move within the players grid and Tab leaves it (WCAG 2.1.2)
    Given I am logged into SquadLogic as an admin
    When I open "/players" and see its "Players" heading
    And I tab from the table search into the "Players grid"
    Then the arrow keys move focus between the cells of the "Players grid"
    And Tab moves focus out of the "Players grid" and Shift+Tab brings it back to the same cell

  Scenario: A row-actions menu in the players grid keeps the grid's single tab stop
    Given I am logged into SquadLogic as an admin
    When I open "/players" and see its "Players" heading
    And I tab from the table search into the "Players grid"
    And I open the first row's actions menu in the "Players grid" from the keyboard
    Then the arrow keys move through the menu and Escape returns to the "Players grid" cell
    And Tab from the open menu leaves the "Players grid" and closes the menu

  Scenario: The analytics charts follow the theme
    Given I am logged into SquadLogic as an admin
    And the organization has 6 evaluation runs on record
    When I open "/admin/analytics" and see its "Analytical Insights" heading
    Then the charts draw their axis labels and gridlines in the "light" theme's tokens
    When I switch to the dark theme and reopen "/admin/analytics" with its "Analytical Insights" heading
    Then the charts draw their axis labels and gridlines in the "dark" theme's tokens

  Scenario Outline: <route> passes axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    When I open "<route>" and see its "<heading>" heading
    Then the scan sees "<content>" on the page
    And axe finds no serious or critical violations on "<route>" in the "light" theme
    When I switch to the dark theme and reopen "<route>" with its "<heading>" heading
    Then the scan sees "<content>" on the page
    And axe finds no serious or critical violations on "<route>" in the "dark" theme

    Examples:
      | route                         | heading                  | content                                 |
      | /                             | Welcome back, Mock       | Division capacity                       |
      | /workflow                     | Season Setup Workflow    | Data Import                             |
      | /import                       | Data Import              | Download players template               |
      | /teams                        | Teaming & Analysis       | Division Breakdown                      |
      | /players                      | Players                  | Alex Smith                              |
      | /players/player-1             | Alex Smith               | Jamie Jones                             |
      | /teams/builder                | Team Builder             | Alex Smith                              |
      | /team/t1                      | Team A                   | Team Chat                               |
      | /scheduling/blackouts         | Blackout Dates           | No closures on file                     |
      | /scores                       | Scores & Results         | Final                                   |
      | /exports                      | Exports                  | Nothing has been published yet          |
      | /admin/members                | Members & Roles          | Mock Coach                              |
      | /coaches                      | Coaches                  | Casey Rivera                            |
      | /coaches/practice-preferences | Practice preferences     | Morgan Reyes                            |
      | /schedule/practice-lighting   | Practice lighting        | Set lighting override                   |
      | /schedule/heat                | Heat forecast            | turned off for this organization        |
      | /fields                       | Field Management         | Field 1                                 |
      | /admin/compliance             | Compliance Dashboard     | Jamie Jones                             |
      | /admin/forms                  | Registration Forms       | Spring 2026 Registration                |
      | /register/f1                  | Spring 2026 Registration | Who are you registering?                |
      | /admin/audit-logs             | Audit Explorer           | Total Events                            |
      | /admin/analytics              | Analytical Insights      | No traceable evaluation records         |
      | /admin/reports                | Enterprise Dashboard     | Organization Readiness                  |
      | /schedule/practice            | Practice Scheduling      | Tigers                                  |
      | /schedule/game                | Game Scheduling          | No Game Schedule Yet                    |
      | /settings                     | Settings                 | League Name                             |
      | /account                      | Account Settings         | Update Password                         |
      | /standings                    | League Standings         | Team A                                  |
      | /setup                        | Season Setup             | Import registrations                    |
      | /setup/features               | Choose your tools        | Years Played                            |
      | /organizations/new            | Welcome to SquadLogic    | Establish Organization                  |
      | /auth/reset-password          | Reset Your Password      | Confirm Password                        |

  # Routes the mock seed leaves empty, scanned again with content on them. The theme is switched
  # on the page itself, so content the page holds only in memory (an invite just generated, a
  # schedule staged for review) is scanned in both themes.

  Scenario: The blackout grid with a blackout on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And a field "Back Pitch" at "Riverside Park" holds a booked game and practice
    When I open "/scheduling/blackouts" and see its "Blackout Dates" heading
    And I add an all-day blackout on "Back Pitch" from "2026-09-16" to "2026-09-16"
    Then the scan sees "Back Pitch" on the page
    And axe finds no serious or critical violations on "/scheduling/blackouts" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Back Pitch" on the page
    And axe finds no serious or critical violations on "/scheduling/blackouts" in the "dark" theme

  Scenario: The heat forecast with a forecast on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And the heat forecast is enabled with the reference venues seeded
    And the NWS API is stubbed with the reference forecast
    And the browser clock reads "2026-10-02T16:00:00Z"
    When I open "/schedule/heat" and see its "Heat forecast" heading
    Then the scan sees "Site A" on the page
    And axe finds no serious or critical violations on "/schedule/heat" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Site A" on the page
    And axe finds no serious or critical violations on "/schedule/heat" in the "dark" theme

  Scenario: Practice lighting with requests and overrides on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And practice slots with lighting overrides are seeded
    When I open "/schedule/practice-lighting" and see its "Practice lighting" heading
    Then the scan sees "2026-10-05" on the page
    And axe finds no serious or critical violations on "/schedule/practice-lighting" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "2026-10-05" on the page
    And axe finds no serious or critical violations on "/schedule/practice-lighting" in the "dark" theme

  Scenario: The analytics page with evaluation runs on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And the organization has 6 evaluation runs on record
    When I open "/admin/analytics" and see its "Analytical Insights" heading
    Then the scan sees "Verified Audit" on the page
    And axe finds no serious or critical violations on "/admin/analytics" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Verified Audit" on the page
    And axe finds no serious or critical violations on "/admin/analytics" in the "dark" theme

  Scenario: Members & Roles with a new invite on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    When I open "/admin/members" and see its "Members & Roles" heading
    And I generate an invite on the Members page
    Then the scan sees "Invite ready" on the page
    And axe finds no serious or critical violations on "/admin/members" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Invite ready" on the page
    And axe finds no serious or critical violations on "/admin/members" in the "dark" theme

  Scenario: Game scheduling with a staged schedule on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    When I press "Generate Schedule" on the Game Scheduling page
    Then the game "Team A" vs "Team B" is staged for review on "Field 1"
    And axe finds no serious or critical violations on "/schedule/game" in the "light" theme
    When I switch to the dark theme on this page
    Then the game "Team A" vs "Team B" is staged for review on "Field 1"
    And axe finds no serious or critical violations on "/schedule/game" in the "dark" theme
