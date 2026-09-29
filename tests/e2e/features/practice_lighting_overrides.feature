Feature: Portable-lighting overrides on practice slots
  As a coach whose practice runs past sunset
  I want to request portable lighting for a date window on my practice slot
  So that an admin can approve it and the scheduler stops cutting the practice short

  8.9 D14 PR D, driven end to end against the mock RPCs. Every check is a DOM
  assertion; the seeded rows are the only place the mock database is touched.

  Scenario: A coach requests lighting on a slot they coach, then withdraws it
    Given I am logged into SquadLogic as a "coach"
    And practice slots with lighting overrides are seeded
    When I open the Practice Lighting page
    Then the slot picker offers exactly the seeded slots I coach
    When I request lighting on "Tue 18:00" from "2026-12-01" to "2026-12-04"
    Then my request from "2026-12-01" shows as "Requested"
    And my request from "2026-12-01" can be withdrawn
    And the request by another user from "2026-11-20" cannot be withdrawn
    When I withdraw my request from "2026-12-01"
    Then my request from "2026-12-01" shows as "Withdrawn"

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
