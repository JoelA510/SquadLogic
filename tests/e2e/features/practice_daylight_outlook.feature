Feature: Practice daylight outlook (read-only)
  As an admin of a youth sports league
  I want to see which evening practices the rest of the season puts in the dark
  So that I can decide what to change before it happens

  Duration-phase wiring, PR B (docs/changes/2026-11-02-duration-phases-wiring.md). The page is
  read-only and proposes only: it changes no practice. A sunset condition is a warning (owner,
  2026-11-02): a date nothing saves is kept as scheduled and flagged, and an unknown sunset is
  flagged and never read as fine. The venue is seeded without coordinates and given them through
  the mock, as the practice repair scenarios do. Every check is a DOM assertion; the mock is
  touched only by the seeding steps.

  Background:
    Given I am logged into SquadLogic as an "admin"
    And a fresh organization is active for the practice daylight outlook
    And I have an organization labeled "Test Org"
    And "Dusk Pitch" holds a Tuesday 18:00 practice for "Dusk Team" at a venue with no coordinates

  Scenario: The outlook says sunset is unknown until the venue has coordinates, then lists the slot that goes dark, and passes axe in both themes
    When I open Practice Daylight from the side navigation
    Then the practice daylight page says the sunset is unknown and points at the venue coordinates
    When the venue of that field is given coordinates through the mock
    And I open "/schedule/practice-daylight" and see its "Practice daylight" heading
    Then the practice daylight page lists "Tuesday 18:00 to 19:00" on "Dusk Pitch" as past sunset from "Tue 22 Sep"
    And the scan sees "Dusk Team" on the page
    And axe finds no serious or critical violations on "/schedule/practice-daylight" in the "light" theme
    When I switch to the dark theme on this page
    Then the scan sees "Dusk Team" on the page
    And axe finds no serious or critical violations on "/schedule/practice-daylight" in the "dark" theme
