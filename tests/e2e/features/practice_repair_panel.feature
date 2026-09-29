Feature: Practice repair recommendations (read-only)
  As an admin of a youth sports league
  I want to see where each displaced practice would go before I close ground
  So that no team is silently left without a practice

  8.6 3b PR 10. The panel is read-only: it shows one recommendation per
  displaced practice series-window, TIME TBD with its reason, and whether a
  save would be refused; declining and undoing happen on screen only. Every
  check is a DOM assertion; the mock is touched only by the seeding step.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a fresh organization is active for the practice repair
    And I have an organization labeled "Test Org"
    And "Repair Pitch 1" holds two practice series, one of a length nothing else offers

  Scenario: Retiring a field shows every displaced practice, and a decline can be undone
    Given I am on the "Field Management" page
    When I click the "Retire" button for "Repair Pitch 1"
    And I set the retirement end date to "2026-09-30"
    And I click "Check and retire"
    Then the consequence preview should offer practice repair recommendations
    When I open the practice repair recommendations
    Then the practice repair panel should list 2 displaced series-windows
    And the recommendation for "Repair Team B" should be TIME TBD with a reason
    And the practice repair panel should say daylight was not checked
    When I decline the recommendation for "Repair Team A"
    Then the recommendation for "Repair Team A" should be TIME TBD with a reason
    And the practice repair panel should say it is locally repaired
    When I undo the decline for "Repair Team A"
    Then the recommendation for "Repair Team A" should be placed

  Scenario: A blackout draft shows each window, and why saving it would be refused
    Given I am on the "Blackout Dates" page
    When I draft an all-day blackout on "Repair Pitch 1" from "2026-10-05" to "2026-10-11"
    And I open the practice repair recommendations
    Then the practice repair panel should list 2 displaced series-windows
    And every practice repair window should show why saving it is refused
