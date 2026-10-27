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
      | /team/t1                      | Team A                   | Team Schedule                           |
      | /scheduling/blackouts         | Blackout Dates           | No closures on file                     |
      | /exports                      | Exports                  | Nothing has been published yet          |
      | /admin/members                | Members & Roles          | Mock Admin                              |
      | /coaches                      | Coaches                  | Casey Rivera                            |
      | /coaches/practice-preferences | Practice preferences     | Morgan Reyes                            |
      | /schedule/practice-lighting   | Practice lighting        | Set lighting override                   |
      | /schedule/heat                | Heat forecast            | turned off for this organization        |
      | /fields                       | Field Management         | Field 1                                 |
      | /permits                      | Field permits            | No permits are on record yet            |
      | /admin/audit-logs             | Audit Explorer           | Total Events                            |
      | /admin/analytics              | Analytical Insights      | No traceable evaluation records         |
      | /admin/reports                | Enterprise Dashboard     | Fluid Attributes Distribution           |
      | /schedule/practice            | Practice Scheduling      | Tigers                                  |
      | /schedule/game                | Game Scheduling          | No Game Schedule Yet                    |
      | /settings                     | Settings                 | League Name                             |
      | /account                      | Account Settings         | Update Password                         |
      | /setup                        | Season Setup             | Import registrations                    |
      | /setup/features               | Choose your tools        | Years Played                            |
      | /organizations/new            | Welcome to SquadLogic    | Establish Organization                  |
      | /auth/reset-password          | Reset Your Password      | Confirm Password                        |

  # The admins' Field Permits page (docs/changes/2026-10-27-admin-only.md, F3), with a permit on it,
  # in both themes.
  Scenario: The permits page, with a permit on it, passes axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    And a permit from "City Recreation" numbered "0042" expires in 12 days, has a file and covers "Field 1"
    When I open "/permits" and see its "Field permits" heading
    Then the scan sees "Central Park, Field 1" on the page
    And axe finds no serious or critical violations on "/permits" in the "light" theme
    When I switch to the dark theme and reopen "/permits" with its "Field permits" heading
    Then the scan sees "Central Park, Field 1" on the page
    And axe finds no serious or critical violations on "/permits" in the "dark" theme

  # Demo mode (docs/changes/2026-10-22-demo-mode.md, D4). The entry page is scanned in its failed
  # state (the demo is full), the one it rests in; the ended page and the demo's own dashboard,
  # with its timer in the header, are scanned as a visitor sees them.

  Scenario: The demo entry page passes axe in the light and dark themes
    Given the demo is full
    When I open the demo entry page
    Then I stay on the entry page and it says the demo is busy
    And axe finds no serious or critical violations on "/demo/start" in the "light" theme
    When I switch the demo entry page to the dark theme
    Then I stay on the entry page and it says the demo is busy
    And axe finds no serious or critical violations on "/demo/start" in the "dark" theme

  Scenario: The demo-ended page passes axe in the light and dark themes
    Given I am signed out on the sign-in page
    When I open the demo-ended page
    Then the scan sees "Your demo has ended" on the page
    And axe finds no serious or critical violations on "/demo/ended" in the "light" theme
    When I switch the demo-ended page to the dark theme
    Then the scan sees "Your demo has ended" on the page
    And axe finds no serious or critical violations on "/demo/ended" in the "dark" theme

  Scenario: The demo league's dashboard, with its timer in the header, passes axe in both themes
    Given I am in the demo league
    Then the scan sees "left" on the page
    And axe finds no serious or critical violations on "/" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "left" on the page
    And axe finds no serious or critical violations on "/" in the "dark" theme

  Scenario: An invite link opened while signed out passes axe in the light and dark themes
    Given I am signed out and open the invite link "SPRING2026"
    Then the scan sees "You've been invited to join an organization" on the page
    And axe finds no serious or critical violations on "/invite/SPRING2026" in the "light" theme
    When I switch the sign-in page to the dark theme
    Then the scan sees "You've been invited to join an organization" on the page
    And axe finds no serious or critical violations on "/invite/SPRING2026" in the "dark" theme

  Scenario: An invite link that cannot be redeemed passes axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    When I open "/invite/NOSUCHCODE" and see its "Invite could not be redeemed" heading
    Then the scan sees "Back to onboarding" on the page
    And axe finds no serious or critical violations on "/invite/NOSUCHCODE" in the "light" theme
    When I switch to the dark theme and reopen "/invite/NOSUCHCODE" with its "Invite could not be redeemed" heading
    Then the scan sees "Back to onboarding" on the page
    And axe finds no serious or critical violations on "/invite/NOSUCHCODE" in the "dark" theme

  # Score entry and standings are off until the league turns them on (admin focus R6,
  # 20261028010000), so each is scanned with its setting on.

  Scenario: Scores & Results passes axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    And the league has turned on score entry and standings
    When I open "/scores" and see its "Scores & Results" heading
    Then the scan sees "Final" on the page
    And axe finds no serious or critical violations on "/scores" in the "light" theme
    When I switch to the dark theme and reopen "/scores" with its "Scores & Results" heading
    Then the scan sees "Final" on the page
    And axe finds no serious or critical violations on "/scores" in the "dark" theme

  Scenario: League standings pass axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    And the league has turned on score entry and standings
    When I open "/standings" and see its "League Standings" heading
    Then the scan sees "Team A" on the page
    And axe finds no serious or critical violations on "/standings" in the "light" theme
    When I switch to the dark theme and reopen "/standings" with its "League Standings" heading
    Then the scan sees "Team A" on the page
    And axe finds no serious or critical violations on "/standings" in the "dark" theme

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

  # Routes whose content the seed leaves out or masks, scanned with it on the page.

  Scenario: Exports with a published baseline and its parity report passes axe in both themes
    Given I am logged into SquadLogic as an admin
    When I open "/exports" and see its "Exports" heading
    And I publish a baseline from the Exports page and compare it with the schedule
    Then the scan sees "The working schedule still matches what was published." on the page
    And axe finds no serious or critical violations on "/exports" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "The working schedule still matches what was published." on the page
    And axe finds no serious or critical violations on "/exports" in the "dark" theme

  Scenario: Practice preferences with a pending request and one in force passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And a coach has a pending practice preference request and another has one in force
    When I open "/coaches/practice-preferences" and see its "Practice preferences" heading
    Then the scan sees "Pending requests (1)" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Pending requests (1)" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "dark" theme

  Scenario: Field management with seasonal availability on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And seasonal availability is imported for a field
    When I open "/fields" and see its "Field Management" heading
    Then the scan sees "Harvest festival" on the page
    And axe finds no serious or critical violations on "/fields" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Harvest festival" on the page
    And axe finds no serious or critical violations on "/fields" in the "dark" theme

  Scenario: Game scheduling with a practice-only division on it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And the team run's division "U8 Boys" plays no games
    When I open "/schedule/game" and see its "Game Scheduling" heading
    Then the scan sees "These divisions play no games" on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "These divisions play no games" on the page
    And axe finds no serious or critical violations on "/schedule/game" in the "dark" theme

  Scenario: Field management with a field's practice slot divisions open passes axe in both themes
    Given I am logged into SquadLogic as an admin
    When I open "/fields" and see its "Field Management" heading
    And I open the practice slot divisions on "Field 1"
    Then the scan sees "0 of 1 reserved" on the page
    And axe finds no serious or critical violations on "/fields" in the "light" theme
    When I switch to the dark theme on this page
    And I open the practice slot divisions on "Field 1"
    Then the scan sees "0 of 1 reserved" on the page
    And axe finds no serious or critical violations on "/fields" in the "dark" theme

  Scenario: The reports page above its three-player masking threshold passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And the organization has 6 players with a custom attribute
    When I open "/admin/reports" and see its "Enterprise Dashboard" heading
    Then the chart of the custom attribute is drawn instead of the privacy mask
    And axe finds no serious or critical violations on "/admin/reports" in the "light" theme
    When I switch to the dark theme on this page
    Then the chart of the custom attribute is drawn instead of the privacy mask
    And axe finds no serious or critical violations on "/admin/reports" in the "dark" theme

  # The main dialog of each route that has one, open: the most-used create or edit dialog where a
  # route has several. The dark scan keeps the dialog open (the overlay covers the theme toggle,
  # so it is clicked through the DOM).

  Scenario Outline: The "<dialog>" dialog on <route> passes axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    When I open "<route>" and see its "<heading>" heading
    And I open the "<dialog>" dialog with "<opener>"
    Then axe finds no serious or critical violations on "<route>" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "<dialog>" on the page
    And axe finds no serious or critical violations on "<route>" in the "dark" theme

    Examples:
      | opener                       | route                 | heading           | dialog                    |
      | Add blackout                 | /scheduling/blackouts | Blackout Dates    | Add a blackout window     |
      | Row actions > Manage teams   | /coaches              | Coaches           | Teams —                   |
      | Add Field                    | /fields               | Field Management  | Add New Field             |
      | Features > Co-ed (combined)  | /settings             | Settings          | Switch to co-ed divisions |
      | Subscribe to Calendar        | /team/t1              | Team A            | Calendar Subscription     |

  Scenario: The decision dialog on practice preferences passes axe in the light and dark themes
    Given I am logged into SquadLogic as an admin
    And a coach has a pending practice preference request and another has one in force
    When I open "/coaches/practice-preferences" and see its "Practice preferences" heading
    And I open the "Approve with change" dialog with "with a change"
    Then axe finds no serious or critical violations on "/coaches/practice-preferences" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "Approve with change" on the page
    And axe finds no serious or critical violations on "/coaches/practice-preferences" in the "dark" theme

  Scenario: The override dialog on practice scheduling passes axe in the light and dark themes
    Given I am logged in as an administrator
    And a practice schedule has been generated
    And the automated schedule has been generated
    And the roster's "Team A" has a saved practice and a second slot is available
    And I am on the Practice Scheduling page
    When I override "Team A" onto the second practice slot and apply
    Then a dialog asks to replace the saved practice of "Team A"
    And the "Override a saved practice" dialog is open with focus inside it
    And axe finds no serious or critical violations on "/schedule/practice" in the "light" theme
    When I switch to the dark theme behind the open dialog
    Then the scan sees "Override a saved practice" on the page
    And axe finds no serious or critical violations on "/schedule/practice" in the "dark" theme

  Scenario: Settings, Season and Calendar with a program in it passes axe in both themes
    Given I am logged into SquadLogic as an admin
    And the season has a program "Junior" holding the division "U8 Coed"
    When I open "/settings" and see its "Settings" heading
    And I open the Season and Calendar settings
    Then the scan sees "Programs are optional" on the page
    And axe finds no serious or critical violations on "/settings" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Programs are optional" on the page
    And axe finds no serious or critical violations on "/settings" in the "dark" theme
