Feature: Portable-lighting overrides on practice slots
  As a league admin whose practices run past sunset
  I want to set portable lighting for a date window on a practice slot
  So that the scheduler stops cutting the practice short

  8.9 D14 PR D, driven end to end against the mock RPCs. Every check is a DOM
  assertion; the seeded rows are the only place the mock database is touched.
  Lighting is admin-only, with no coach requests, since admin focus R6
  (20261028010000, owner decision 4): the seeded requests are rows coaches
  requested before then, which an admin still decides.

  Scenario: A member whose role the league no longer has gets no lighting page
    Given I am logged into SquadLogic as an "admin"
    And my membership carries the removed role "coach"
    When I go to "/schedule/practice-lighting"
    Then I should be redirected to the Dashboard

  Scenario: An admin cannot decide their own request, and an overlapping approval is explained
    Given I am logged into SquadLogic as an "admin"
    And practice slots with lighting overrides are seeded
    When I open the Practice Lighting page
    Then the pending request from "2026-10-01" cannot be decided by me, with the reason shown
    And the no-lights-off note is shown beside the approve action
    When I approve the pending request from "2026-10-05"
    Then I see the lighting overlap message
    When I withdraw the approved override from "2026-10-07"
    And I approve the pending request from "2026-10-05"
    Then the approved override from "2026-10-05" is listed
