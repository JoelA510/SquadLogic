Feature: Field lifecycle and blackout administration
  As an admin of a youth sports league
  I want to retire ground with an end date and record when it is closed
  So that the scheduler stops offering ground the club cannot use

  These two scenarios are 8.4's two UI acceptance criteria, driven end to end.
  Neither asserts on mock internals: every check is a DOM assertion on what an
  operator would see.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And I have an organization labeled "Test Org"

  Scenario: Retiring a surface that hosts a booked practice is refused, then confirmed
    Given a field "Back Pitch" at "Riverside Park" holds a booked practice
    And I am on the "Field Management" page
    When I click the "Retire" button for "Back Pitch"
    And I set the retirement end date to "2026-09-30"
    And I click "Check and retire"
    Then I should see a consequence preview naming 1 affected booking
    And the consequence preview should name the missing repair engine
    And "Back Pitch" should not yet show a retirement date
    When I click "Retire anyway"
    Then "Back Pitch" should show a retirement date of "2026-09-30"

  Scenario: A blackout added through the UI shows as a conflict until it is removed
    Given a field "Back Pitch" at "Riverside Park" holds a booked game and practice
    And I am on the "Blackout Dates" page
    Then the blackout grid should be empty
    When I add an all-day blackout on "Back Pitch" from "2026-09-16" to "2026-09-16"
    Then the blackout grid should report 2 bookings closed
    And the game schedule should show a blackout conflict
    And the practice schedule should show a blackout conflict
    When I edit the blackout to cover "2026-09-15" instead
    Then the blackout grid should hold exactly 1 window, moved to "2026-09-15"
    And the game schedule should show no blackout conflict
    And the practice schedule should show no blackout conflict
    When I remove the blackout from the blackout grid
    Then the game schedule should show no blackout conflict
    And the practice schedule should show no blackout conflict
