Feature: Retiring a venue and a sub-surface
  As an admin of a youth sports league
  I want to close a whole site, or one half-pitch, with an end date
  So that the scheduler stops offering ground the club cannot use

  8.4 gap B part 2's two UI paths, driven end to end. Neither asserts on mock
  internals: every check is a DOM assertion on what an operator would see.

  The load-bearing one is CONTAINMENT. A venue retirement writes one date on
  one row and copies nothing down, so the pitches at a closed site stop being
  offered without carrying a date of their own. An implementation that pushed
  the date down would satisfy every count in the preview and fail only the step
  that reads the pitch cards afterwards.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And I have an organization labeled "Test Org"

  Scenario: Retiring a venue shows both halves of the consequence, then closes the site without dating its pitches
    Given a venue "Maplewood Park" holds two pitches and a booked practice
    And I am on the "Field Management" page
    When I click the retire control for the venue "Maplewood Park"
    Then the retirement dialog should be addressed to a venue
    When I set the venue retirement end date to "2026-09-30"
    And I click "Check and retire"
    Then I should see a consequence preview naming 1 affected booking
    And the consequence preview should name the missing repair engine
    And the consequence preview should list the ground the venue contains
    And the contained ground should not be listed as bookings
    And "Maplewood Park" should not yet show a retirement date
    When I click "Retire anyway"
    Then the venue "Maplewood Park" should show a retirement date of "2026-09-30"
    And no pitch at "Maplewood Park" should carry a retirement date of its own
    When I clear the end date on the venue "Maplewood Park"
    Then the venue "Maplewood Park" should show no retirement date

  Scenario: Retiring one sub-surface leaves its sibling and its parent pitch alone
    Given a venue "Maplewood Park" holds a pitch split into two halves
    And I am on the "Field Management" page
    When I click the retire control for the sub-surface "North A"
    Then the retirement dialog should be addressed to a sub-surface
    And the retirement dialog should offer no containment
    When I set the sub-surface retirement end date to "2026-09-30"
    And I click "Check and retire"
    Then the sub-surface "North A" should show a retirement date of "2026-09-30"
    And the sub-surface "North B" should show no retirement date
    And no pitch at "Maplewood Park" should carry a retirement date of its own
