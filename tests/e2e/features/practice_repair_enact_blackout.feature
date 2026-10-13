Feature: Enacting a blackout's practice repair recommendations
  As an admin of a youth sports league
  I want to move or mark TIME TBD the practices a saved blackout closes
  So that families see the temporary change, and the series keeps its range

  8.6 3b PR 11d-3 (docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md B12). The
  blackout editor's launcher is always a preview (Q5); once the blackout is
  saved, its row on Blackout Dates opens the panel over the STORED window.
  One relocation and one TIME TBD are enacted through the override prompt,
  then a parent sees each in the team portal. Every check is a DOM
  assertion; the mock is touched only by the seeding steps, and every seeded
  row carries organization_id.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a fresh organization is active for the practice repair
    And I have an organization labeled "Test Org"
    And "Repair Pitch 1" holds two practice series, one of a length nothing else offers

  Scenario: A saved blackout's relocation and TIME TBD are enacted, and a parent sees both
    Given I am on the "Blackout Dates" page
    When I save an all-day blackout on "Repair Pitch 1" from "2026-11-02" to "2026-11-08"
    And I open the practice repair for the saved blackout on "Repair Pitch 1"
    And I enact the recommendation for "Repair Team A", accepting the override
    Then the practice of "Repair Team A" should be shown temporarily moved and locked
    When I enact the recommendation for "Repair Team B", accepting the override
    Then the practice of "Repair Team B" should be shown temporarily TIME TBD and locked
    When a parent of a "Repair Team A" player opens its team portal
    Then the parent should see the practice on "2026-11-04" as "Practice (moved)"
    When a parent of a "Repair Team B" player opens its team portal
    Then the parent should see the practice on "2026-11-05" as TIME TBD
